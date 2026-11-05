import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type Sandbox } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { requestAuthStorage } from '../../core/request-context';
import { AuditService } from '../../core/audit.service';
import { AnalyticsService } from '../../core/analytics.service';
import { RedisThrottleService } from '../../core/rate-limit.service';
import { InstanceSettingsService } from '../../core/instance-settings.service';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { refOf } from '../runners/sandbox-runner';
import { SandboxAccessService, type SandboxAccessRow } from '../sandbox-access.service';
import {
  SandboxSessionsService,
  parseGithubRemote,
  type SessionDto
} from '../sandbox-sessions.service';
import {
  REPO_REMOTES_SCRIPT,
  findRepoByRemote,
  parseRepoRemotes,
  repoMentions,
  repoNameMentioned,
  sessionUrl,
  type IssueContext,
  type KickoffProvider,
  type RepoRemote
} from './integration-helpers';

export type KickoffTarget =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'hint'; text: string };

export interface MachineCandidate {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'status'>;
  remotes: RepoRemote[];
}

export interface RecentMachine {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'status'>;
  repo: string;
}

export type MachineChoice =
  | { kind: 'ok'; sandboxId: string; repo: string }
  | { kind: 'stopped'; sandboxId: string; repo: string; message: string }
  | { kind: 'none'; message: string };

export type KickoffResult =
  | {
      kind: 'started';
      sandbox: { id: string; name: string };
      repo: string;
      session: SessionDto;
      url: string;
    }
  | { kind: 'failed'; reason: string };

export const UNTRUSTED_AUTHOR_REASON =
  'this issue was written by someone who is not the host or a guest of that machine, so only its host can start a session from it. Ask the host, or have the author link their Orchard account and get invited as a guest';

export async function issueAuthorRefusal(
  access: Pick<SandboxAccessService, 'resolve'>,
  sandboxId: string,
  kickerUserId: string,
  authorUserId: string | null | undefined
): Promise<string | null> {
  const kicker = await access.resolve(sandboxId, kickerUserId);
  if (kicker?.role === 'owner') return null;
  if (authorUserId) {
    const author = await access.resolve(sandboxId, authorUserId);
    if (author && (author.role === 'owner' || author.role === 'collaborator')) return null;
  }
  return UNTRUSTED_AUTHOR_REASON;
}

const KICKOFF_WINDOW = { maxAttempts: 5, windowMs: 60_000, blockDurationMs: 60_000 };
const MAX_RUNNING_PROBED = 5;
const REMOTES_TIMEOUT_MS = 15_000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function chooseMachine(input: {
  target: KickoffTarget;
  running: MachineCandidate[];
  recent: RecentMachine | null;
}): MachineChoice {
  const { target, running, recent } = input;
  const wanted =
    target.kind === 'repo'
      ? [{ owner: target.owner, repo: target.repo }]
      : repoMentions(target.text);
  for (const want of wanted) {
    for (const candidate of running) {
      const hit = findRepoByRemote(candidate.remotes, want);
      if (hit) return { kind: 'ok', sandboxId: candidate.sandbox.id, repo: hit.name };
    }
  }
  if (target.kind === 'hint') {
    for (const candidate of running) {
      const name = repoNameMentioned(
        target.text,
        candidate.remotes.map((r) => r.name)
      );
      if (name) return { kind: 'ok', sandboxId: candidate.sandbox.id, repo: name };
    }
  }
  if (recent) {
    const relevant =
      target.kind === 'hint' || recent.repo.toLowerCase() === target.repo.toLowerCase();
    if (relevant && recent.sandbox.status === 'running') {
      return { kind: 'ok', sandboxId: recent.sandbox.id, repo: recent.repo };
    }
    if (relevant) {
      return {
        kind: 'stopped',
        sandboxId: recent.sandbox.id,
        repo: recent.repo,
        message: `the machine that has ${recent.repo} is ${recent.sandbox.status}. Start it in Orchard and try again`
      };
    }
  }
  if (target.kind === 'repo') {
    return {
      kind: 'none',
      message: `none of your machines has ${target.owner}/${target.repo} cloned. Clone it into a machine you host and try again`
    };
  }
  return {
    kind: 'none',
    message:
      'I could not tell which repo to use. Mention one (owner/name or the name of a repo cloned on your machine), or start a session in Orchard first'
  };
}

export interface KickoffInput {
  provider: KickoffProvider;
  userId: string;
  target: KickoffTarget;
  prompt: string;
  title?: string;
  issue?: IssueContext | null;
  contentAuthorUserId?: string | null;
}

@Injectable()
export class KickoffRateLimiter {
  private readonly memory = new Map<string, number[]>();

  constructor(@Optional() private readonly throttle?: RedisThrottleService) {}

  async allow(userId: string, nowMs = Date.now()): Promise<boolean> {
    const shared = this.throttle
      ? await this.throttle
          .consume(`greenhouse_kickoff:user:${userId}`, KICKOFF_WINDOW)
          .catch(() => null)
      : null;
    if (shared !== null) return shared === 0;
    const recent = (this.memory.get(userId) ?? []).filter(
      (t) => nowMs - t < KICKOFF_WINDOW.windowMs
    );
    if (recent.length >= KICKOFF_WINDOW.maxAttempts) {
      this.memory.set(userId, recent);
      return false;
    }
    recent.push(nowMs);
    this.memory.set(userId, recent);
    if (this.memory.size > 10_000) {
      for (const [key, times] of this.memory) {
        if (!times.some((t) => nowMs - t < KICKOFF_WINDOW.windowMs)) this.memory.delete(key);
      }
    }
    return true;
  }
}

@Injectable()
export class GreenhouseKickoffService {
  private readonly logger = new Logger(GreenhouseKickoffService.name);

  private lastPrune = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly sessions: SandboxSessionsService,
    private readonly access: SandboxAccessService,
    private readonly settings: InstanceSettingsService,
    private readonly limiter: KickoffRateLimiter,
    private readonly audit: AuditService,
    @Optional() private readonly analytics?: AnalyticsService
  ) {}

  async claimDelivery(provider: KickoffProvider, deliveryId: string): Promise<boolean> {
    const id = deliveryId.trim().slice(0, 255);
    if (!id) return false;
    this.pruneDeliveries();
    try {
      await this.prisma.sandboxIntegrationDelivery.create({ data: { provider, deliveryId: id } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  private pruneDeliveries(): void {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    void this.prisma.sandboxIntegrationDelivery
      .deleteMany({ where: { createdAt: { lt: new Date(now - DELIVERY_RETENTION_MS) } } })
      .catch(() => {});
  }

  async enabledFor(userId: string): Promise<boolean> {
    if (!(await this.settings.isSandboxesEnabled().catch(() => false))) return false;
    if (this.analytics?.configured) {
      return this.analytics.isFeatureEnabled('greenhouse', userId).catch(() => false);
    }
    return true;
  }

  async repoRemotes(sandbox: Sandbox): Promise<RepoRemote[]> {
    if (sandbox.status !== 'running') return [];
    const result = await this.registry
      .for(sandbox)
      .exec(refOf(sandbox), ['su', '-l', 'dev', '-c', REPO_REMOTES_SCRIPT], {
        timeoutMs: REMOTES_TIMEOUT_MS
      });
    return parseRepoRemotes(result.stdout);
  }

  private async recentMachine(
    userId: string,
    target: KickoffTarget
  ): Promise<RecentMachine | null> {
    const session = await this.prisma.sandboxConversation.findFirst({
      where: {
        createdById: userId,
        slug: { not: null },
        repo: target.kind === 'repo' ? { equals: target.repo, mode: 'insensitive' } : { not: null },
        sandbox: { desiredState: { not: 'deleted' } }
      },
      orderBy: { createdAt: 'desc' },
      select: { repo: true, sandbox: { select: { id: true, name: true, status: true } } }
    });
    if (session?.repo) return { sandbox: session.sandbox, repo: session.repo };
    if (target.kind !== 'repo') return null;
    const owned = await this.prisma.sandbox.findMany({
      where: { userId, desiredState: { not: 'deleted' }, repoUrl: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, name: true, status: true, repoUrl: true }
    });
    for (const sandbox of owned) {
      const remote = parseGithubRemote(sandbox.repoUrl);
      if (
        remote &&
        remote.owner.toLowerCase() === target.owner.toLowerCase() &&
        remote.repo.toLowerCase() === target.repo.toLowerCase()
      ) {
        return { sandbox, repo: remote.repo };
      }
    }
    return null;
  }

  async pickMachine(userId: string, target: KickoffTarget): Promise<MachineChoice> {
    const running = await this.prisma.sandbox.findMany({
      where: { userId, status: 'running', desiredState: { not: 'deleted' } },
      orderBy: { createdAt: 'desc' },
      take: MAX_RUNNING_PROBED
    });
    const candidates: MachineCandidate[] = [];
    for (const sandbox of running) {
      const remotes = await this.repoRemotes(sandbox).catch((e: any) => {
        this.logger.warn(`could not list repos on ${sandbox.id}: ${e?.message}`);
        return [] as RepoRemote[];
      });
      candidates.push({ sandbox, remotes });
    }
    const recent = await this.recentMachine(userId, target);
    return chooseMachine({ target, running: candidates, recent });
  }

  start(input: KickoffInput): Promise<KickoffResult> {
    return requestAuthStorage.run({ browserSession: true }, () => this.startAs(input));
  }

  private async startAs(input: KickoffInput): Promise<KickoffResult> {
    const { provider, userId } = input;
    if (!(await this.enabledFor(userId))) {
      return { kind: 'failed', reason: 'Greenhouse is not enabled for your account' };
    }
    if (!(await this.limiter.allow(userId))) {
      return {
        kind: 'failed',
        reason: 'you started too many sessions in the last minute. Wait a moment and try again'
      };
    }
    const choice = await this.pickMachine(userId, input.target);
    if (choice.kind !== 'ok') return { kind: 'failed', reason: choice.message };
    let granted: { sandbox: SandboxAccessRow } | null = null;
    try {
      granted = await this.access.requireSandboxRole(choice.sandboxId, userId, 'collaborator');
    } catch {
      granted = null;
    }
    if (!granted) {
      return { kind: 'failed', reason: 'you do not have guest access to that machine any more' };
    }
    const sandbox = granted.sandbox;
    if (input.issue) {
      const refusal = await issueAuthorRefusal(
        this.access,
        sandbox.id,
        userId,
        input.contentAuthorUserId
      );
      if (refusal) return { kind: 'failed', reason: refusal };
    }
    let session: SessionDto;
    try {
      session = await this.sessions.create(
        sandbox,
        userId,
        { repo: choice.repo, prompt: input.prompt, ...(input.title ? { title: input.title } : {}) },
        input.issue ? { issue: input.issue } : {}
      );
    } catch (e: any) {
      return {
        kind: 'failed',
        reason: `the session could not be created: ${String(e?.message ?? 'unknown error').slice(0, 200)}`
      };
    }
    await this.audit.log({
      action: 'sandbox.session.started_from',
      actorUserId: userId,
      organizationId: sandbox.organizationId,
      targetType: 'sandbox_session',
      targetId: session.id,
      targetLabel: session.title,
      metadata: { provider, sandboxId: sandbox.id, repo: choice.repo }
    });
    return {
      kind: 'started',
      sandbox: { id: sandbox.id, name: sandbox.name },
      repo: choice.repo,
      session,
      url: sessionUrl(sandbox.id, session.id)
    };
  }
}
