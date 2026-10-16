import { EventEmitter } from 'events';
import {
  chatTitleFor,
  isAgentTitle,
  isGeneratedSessionName,
  pickSessionName,
  promptTitle
} from './session-names';
import { randomBytes, randomUUID } from 'crypto';
import { posix } from 'path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { Prisma, type SandboxConversation } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { GitHubService } from '../core/github.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxNotRunningError, refOf } from './runners/sandbox-runner';
import { SandboxWorkspaceService, type WorkspaceSandbox } from './sandbox-workspace.service';
import {
  PREVIEW_DEPLOYMENT_SELECT,
  previewSnapshotOf,
  type PreviewSnapshot,
  type PreviewStatus
} from './links/preview-state';
import {
  WORKTREE_EXIT,
  buildDiffstatBatchScript,
  buildPortsScript,
  buildRepoRemoveScript,
  buildPoolSetupAdopt,
  buildScriptLaunch,
  buildScriptStop,
  isScriptName,
  scriptNameOf,
  buildScriptsProbe,
  buildWorktreeAddScript,
  buildWorktreeRemoveScript,
  buildWorktreeRestoreScript,
  isUuid,
  isValidBranchPrefix,
  isValidGitRef,
  isValidRepoName,
  inWorktree,
  isValidSlug,
  isWorktreePath,
  worktreeKeyOf,
  parseDiffstatBatch,
  parseGreenhouseConfig,
  parsePortsOutput,
  parseScriptsProbe,
  parseWorktreeAddOutput,
  repoPathFor,
  scriptFiles,
  SESSION_BRANCH_PREFIX,
  sessionBranch,
  setupStateOf,
  shellQuote,
  slugify,
  worktreePathFor,
  type GreenhouseConfig,
  type SessionGitStats,
  type SetupState
} from './sandbox-session-commands';
import { declaredPreviewPorts, mergeDeclaredPorts, previewablePorts } from './preview/preview-auth';
import { newOpencodeMessageId } from './sandbox-opencode-policy';
import {
  buildCoauthorHookInlineInstall,
  buildCoauthorHookInstall,
  COAUTHOR_HOOK_SCRIPT
} from './sandbox-coauthors';

export type SessionActivity = 'idle' | 'working' | 'needs_input' | 'done';

export type PrState = 'open' | 'merged' | 'closed';

export interface SessionUserDto {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface SessionDto {
  id: string;
  sandboxId: string;
  title: string;
  slug: string;
  repo: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  worktreePath: string | null;
  agent: string;
  agentChatId: string | null;
  opencodeSessionId: string | null;
  status: 'active' | 'archived';
  activity: SessionActivity;
  diffstat: { files: number; additions: number; deletions: number } | null;
  aheadBehind: { ahead: number; behind: number } | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: PrState | null;
  previewDeploymentId: string | null;
  previewUrl: string | null;
  previewStatus: PreviewStatus | null;
  createdBy: SessionUserDto | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  preparing: boolean;
  prepareError: string | null;
}

export interface SessionCommandDto {
  id: string;
  label: string;
  icon: string | null;
  running: boolean;
}

export interface SessionScriptsDto extends Omit<GreenhouseConfig, 'commands'> {
  setupState: SetupState;
  running: boolean;
  commands: SessionCommandDto[];
}

export interface SessionCheckDto {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  logExcerpt?: string;
}

export interface SessionChecksDto {
  pr: {
    number: number;
    url: string;
    title: string;
    state: PrState;
    draft: boolean;
    mergeable: boolean | null;
    mergeableState: string | null;
    headSha: string;
    headBranch: string;
    baseBranch: string;
  } | null;
  checks: SessionCheckDto[];
}

const CREATOR_SELECT = {
  select: { id: true, username: true, firstName: true, lastName: true, imageUrl: true }
} as const;

type SessionRow = SandboxConversation & {
  createdBy: {
    id: string;
    username: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string | null;
  } | null;
};

const ACTIVITY_TIMEOUT_MS = 2500;
const OPENCODE_CREATE_TIMEOUT_MS = 15_000;
const DIFFSTAT_TIMEOUT_MS = 20_000;
const WORKTREE_TIMEOUT_MS = 90_000;
const PREPARE_STALE_MS = 10 * 60_000;
const GITHUB_TIMEOUT_MS = 10_000;
const MAX_FAILED_LOGS = 3;
const LOG_EXCERPT_LINES = 60;
const LOG_EXCERPT_BYTES = 6000;
const MAX_TITLE = 120;
const AGENT_TITLE_DELAYS_MS = [4_000, 8_000, 20_000, 40_000];
const MAX_PROMPT = 32768;
const GH_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export function displayName(user: SessionRow['createdBy']): string {
  if (!user) return 'Unknown';
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.username;
}

export const NATIVE_AGENT = 'opencode';

export function newAcpChatId(): string {
  return `acp_${randomBytes(12).toString('hex')}`;
}
export const ACP_AGENT_PREFIX = 'acp:';
const ACP_AGENT_RE = /^acp:[A-Za-z0-9_-]{1,28}$/;

export function acpAgentOf(agent: string | null | undefined): string | null {
  return agent && ACP_AGENT_RE.test(agent) ? agent.slice(ACP_AGENT_PREFIX.length) : null;
}

export function sessionAgentFor(requested: unknown): string {
  const fallback = process.env.SANDBOX_DEFAULT_AGENT?.trim() || NATIVE_AGENT;
  const value =
    requested === undefined || requested === null || requested === '' ? fallback : requested;
  if (value === NATIVE_AGENT) return NATIVE_AGENT;
  if (typeof value === 'string' && ACP_AGENT_RE.test(value)) return value;
  if (requested === undefined || requested === null || requested === '') return NATIVE_AGENT;
  throw new BadRequestException('Unknown agent');
}

export interface PoolClaim {
  claimed: boolean;
  path?: string;
  base?: string;
  commit?: string;
  setup?: string;
  name?: string;
  chat?: { id: string; agent: string; activity: string; agentSessionId?: string } | null;
  warm?: boolean;
}

export interface SessionAgentHost {
  claim(
    sandbox: WorkspaceSandbox,
    input: {
      repo: string;
      base: string | null;
      branch: string;
      agent: string | null;
      chatId: string | null;
      title: string;
      prompt: string;
      actorUserId: string;
    }
  ): Promise<PoolClaim | null>;
  ensurePool(
    sandbox: WorkspaceSandbox,
    input: { repo: string; base: string | null; agent: string | null; setup: string | null }
  ): Promise<void>;
  startChat(
    sandbox: WorkspaceSandbox,
    session: { id: string },
    actorUserId: string,
    input: { id: string; agent: string; title: string; prompt: string }
  ): Promise<unknown>;
  adoptChat(
    sandbox: WorkspaceSandbox,
    session: { id: string },
    actorUserId: string,
    chat: { id: string; agent: string },
    title: string
  ): Promise<void>;
  primaryChats(conversationIds: string[]): Promise<Map<string, string>>;
}

export function isPreparing(
  row: Pick<SandboxConversation, 'worktreePath' | 'baseCommit' | 'prepareError' | 'archivedAt'> & {
    createdAt: Date | string;
  }
): boolean {
  const pending = !!row.worktreePath && !row.baseCommit && !row.prepareError && !row.archivedAt;
  return pending && Date.now() - new Date(row.createdAt).getTime() <= PREPARE_STALE_MS;
}

export function toSessionDto(
  row: SessionRow,
  extras: {
    activity?: SessionActivity;
    stats?: SessionGitStats | null;
    preview?: PreviewSnapshot | null;
    agentChatId?: string | null;
  } = {}
): SessionDto {
  const prState =
    row.prState === 'open' || row.prState === 'merged' || row.prState === 'closed'
      ? row.prState
      : null;
  const pending = !!row.worktreePath && !row.baseCommit && !row.prepareError && !row.archivedAt;
  const preparing = isPreparing(row);
  const stale = pending && !preparing;
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    title: row.title,
    slug: row.slug ?? '',
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    worktreePath: row.worktreePath,
    agent: row.agent || NATIVE_AGENT,
    agentChatId: extras.agentChatId ?? null,
    opencodeSessionId: row.opencodeSessionId,
    status: row.archivedAt ? 'archived' : 'active',
    activity: extras.activity ?? 'idle',
    diffstat: extras.stats?.diffstat ?? null,
    aheadBehind: extras.stats?.aheadBehind ?? null,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    prState,
    previewDeploymentId: row.previewDeploymentId,
    previewUrl: !row.previewDeploymentId
      ? null
      : (extras.preview?.url ?? (extras.preview?.status === 'gone' ? null : row.previewUrl)),
    previewStatus: row.previewDeploymentId ? (extras.preview?.status ?? null) : null,
    createdBy: row.createdBy
      ? {
          id: row.createdBy.id,
          name: displayName(row.createdBy),
          avatarUrl: row.createdBy.imageUrl
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    preparing,
    prepareError:
      row.prepareError ?? (stale ? 'Setup was interrupted before the session was ready' : null)
  };
}

export function parsePrUrl(url: string | null | undefined): {
  owner: string;
  repo: string;
  number: number;
} | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m || !GH_NAME_RE.test(m[1]) || !GH_NAME_RE.test(m[2])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function parseGithubRemote(remote: string | null | undefined): {
  owner: string;
  repo: string;
} | null {
  if (typeof remote !== 'string') return null;
  const m = remote.trim().match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m || !GH_NAME_RE.test(m[1]) || !GH_NAME_RE.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

export function parseIssueRef(
  ref: string,
  fallback: { owner: string; repo: string } | null
): { owner: string; repo: string; number: number } | null {
  const trimmed = ref.trim();
  const valid = (owner: string, repo: string, n: string) =>
    GH_NAME_RE.test(owner) && GH_NAME_RE.test(repo) ? { owner, repo, number: Number(n) } : null;
  const url = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (url) return valid(url[1], url[2], url[3]);
  const qualified = trimmed.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (qualified) return valid(qualified[1], qualified[2], qualified[3]);
  const bare = trimmed.match(/^#?(\d+)$/);
  if (bare && fallback) return valid(fallback.owner, fallback.repo, bare[1]);
  return null;
}

export function branchOf(row: { slug: string | null; branch: string | null }): string | null {
  if (row.branch && isValidGitRef(row.branch)) return row.branch;
  return row.slug && isValidSlug(row.slug) ? sessionBranch(row.slug) : null;
}

export function activityFromStatus(body: unknown): SessionActivity {
  if (!body || typeof body !== 'object') return 'idle';
  for (const value of Object.values(body as Record<string, unknown>)) {
    const type = (value as { type?: unknown } | null)?.type;
    if (type === 'busy' || type === 'retry') return 'working';
  }
  return 'idle';
}

export function excerptLog(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, '').replace(/\r$/, ''));
  let tail = lines.slice(-LOG_EXCERPT_LINES).join('\n').trim();
  if (tail.length > LOG_EXCERPT_BYTES) tail = tail.slice(tail.length - LOG_EXCERPT_BYTES);
  return tail;
}

export interface SessionIssueContext {
  title: string | null;
  text: string;
  slugHint?: string | null;
}

export type PromptRecorder = (input: {
  sandboxId: string;
  userId: string;
  chatId: string;
  messageId: string;
  directory: string | null;
  fresh?: boolean;
}) => Promise<boolean>;

export interface SessionPreviewHooks {
  teardown(
    sandbox: WorkspaceSandbox,
    row: SandboxConversation,
    reason: 'archived' | 'deleted'
  ): Promise<void>;
}

export type SessionIssueResolver = (input: {
  sandbox: WorkspaceSandbox;
  repo: string;
  actorUserId: string;
  provider: 'github' | 'linear';
  ref: string;
}) => Promise<SessionIssueContext | null>;

@Injectable()
export class SandboxSessionsService {
  private readonly logger = new Logger(SandboxSessionsService.name);

  private issueResolver: SessionIssueResolver | null = null;

  readonly events = new EventEmitter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly workspace: SandboxWorkspaceService,
    @Inject(GitHubService) private readonly tokens: Pick<GitHubService, 'getValidUserToken'>
  ) {
    this.events.setMaxListeners(0);
  }

  private promptRecorder: PromptRecorder | null = null;

  private agentHost: SessionAgentHost | null = null;

  setAgentHost(host: SessionAgentHost | null): void {
    this.agentHost = host;
  }

  setPromptRecorder(recorder: PromptRecorder | null): void {
    this.promptRecorder = recorder;
  }

  private previewHooks: SessionPreviewHooks | null = null;

  setPreviewHooks(hooks: SessionPreviewHooks | null): void {
    this.previewHooks = hooks;
  }

  private previewTeardown(
    sandbox: WorkspaceSandbox,
    row: SandboxConversation,
    reason: 'archived' | 'deleted'
  ): void {
    if (!this.previewHooks || (!row.previewDeploymentId && !row.previewEnvironmentId)) return;
    void this.previewHooks
      .teardown(sandbox, row, reason)
      .catch((e) => this.logger.warn(`preview teardown failed for ${row.id}: ${e?.message}`));
  }

  async notifyChanged(sandbox: WorkspaceSandbox, sessionId: string): Promise<SessionDto> {
    const dto = await this.get(sandbox, sessionId);
    this.emit(dto);
    return dto;
  }

  setIssueResolver(resolver: SessionIssueResolver | null): void {
    this.issueResolver = resolver;
  }

  onSessionChanged(listener: (sandboxId: string, session: SessionDto) => void): () => void {
    this.events.on('session', listener);
    return () => this.events.off('session', listener);
  }

  onSessionDeleted(listener: (sandboxId: string, sessionId: string) => void): () => void {
    this.events.on('session-deleted', listener);
    return () => this.events.off('session-deleted', listener);
  }

  private emit(session: SessionDto): void {
    try {
      this.events.emit('session', session.sandboxId, session);
    } catch (e: any) {
      this.logger.warn(`session listener failed: ${e?.message}`);
    }
  }

  private requireRunning(sandbox: { status: string }): void {
    if (sandbox.status !== 'running') throw new SandboxNotRunningError();
  }

  private async row(sandboxId: string, sessionId: string): Promise<SessionRow> {
    if (!isUuid(sessionId)) throw new BadRequestException('Invalid session id');
    const row = await this.prisma.sandboxConversation.findFirst({
      where: { id: sessionId, sandboxId, slug: { not: null } },
      include: { createdBy: CREATOR_SELECT }
    });
    if (!row) throw new NotFoundException('Session not found');
    return row;
  }

  private async activeRow(sandboxId: string, sessionId: string): Promise<SessionRow> {
    const row = await this.row(sandboxId, sessionId);
    if (row.archivedAt) throw new BadRequestException('This session is archived');
    if (!isWorktreePath(row.worktreePath) || !row.repo) {
      throw new BadRequestException('This session has no worktree');
    }
    return row;
  }

  private devExec(sandbox: WorkspaceSandbox, script: string, timeoutMs = 30_000, stdin?: Buffer) {
    return this.registry.for(sandbox).exec(refOf(sandbox), ['su', '-l', 'dev', '-c', script], {
      timeoutMs,
      ...(stdin ? { stdin } : {})
    });
  }

  async get(sandbox: WorkspaceSandbox, sessionId: string): Promise<SessionDto> {
    const row = await this.row(sandbox.id, sessionId);
    const [withStats] = await this.decorate(sandbox, [row]);
    return withStats;
  }

  async list(
    sandbox: WorkspaceSandbox,
    opts: { includeArchived?: boolean } = {}
  ): Promise<{ sessions: SessionDto[] }> {
    const rows = await this.prisma.sandboxConversation.findMany({
      where: {
        sandboxId: sandbox.id,
        slug: { not: null },
        ...(opts.includeArchived ? {} : { archivedAt: null })
      },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: CREATOR_SELECT }
    });
    return { sessions: await this.decorate(sandbox, rows) };
  }

  private async previewSnapshots(rows: SessionRow[]): Promise<Map<string, PreviewSnapshot>> {
    const ids = [
      ...new Set(rows.map((r) => r.previewDeploymentId).filter((id): id is string => !!id))
    ];
    if (ids.length === 0) return new Map();
    try {
      const deployments = await this.prisma.deployment.findMany({
        where: { id: { in: ids } },
        select: PREVIEW_DEPLOYMENT_SELECT
      });
      const byId = new Map(deployments.map((d) => [d.id, d]));
      const out = new Map<string, PreviewSnapshot>();
      for (const r of rows) {
        if (r.previewDeploymentId) {
          out.set(r.id, previewSnapshotOf(byId.get(r.previewDeploymentId)));
        }
      }
      return out;
    } catch (e: any) {
      this.logger.warn(`preview status lookup failed: ${e?.message}`);
      return new Map();
    }
  }

  private async decorate(sandbox: WorkspaceSandbox, rows: SessionRow[]): Promise<SessionDto[]> {
    const [previews, chats] = await Promise.all([
      this.previewSnapshots(rows),
      this.agentHost
        ? this.agentHost.primaryChats(rows.map((r) => r.id)).catch(() => new Map<string, string>())
        : Promise.resolve(new Map<string, string>())
    ]);
    const active = rows.filter((r) => !r.archivedAt && isWorktreePath(r.worktreePath));
    if (sandbox.status !== 'running' || active.length === 0) {
      return rows.map((r) =>
        toSessionDto(r, { preview: previews.get(r.id), agentChatId: chats.get(r.id) ?? null })
      );
    }
    const [stats, activity] = await Promise.all([
      this.batchStats(sandbox, active).catch((e) => {
        this.logger.warn(`diffstat batch failed for ${sandbox.id}: ${e?.message}`);
        return new Map<string, SessionGitStats>();
      }),
      this.batchActivity(sandbox, active)
    ]);
    return rows.map((r) =>
      toSessionDto(r, {
        stats: stats.get(r.id.toLowerCase()) ?? null,
        activity: activity.get(r.worktreePath ?? '') ?? 'idle',
        preview: previews.get(r.id),
        agentChatId: chats.get(r.id) ?? null
      })
    );
  }

  private async batchStats(
    sandbox: WorkspaceSandbox,
    rows: SessionRow[]
  ): Promise<Map<string, SessionGitStats>> {
    const script = buildDiffstatBatchScript(
      rows.map((r) => ({
        id: r.id,
        worktreePath: r.worktreePath ?? '',
        baseBranch: r.baseBranch,
        baseCommit: r.baseCommit
      }))
    );
    if (!script) return new Map();
    const result = await this.devExec(sandbox, script, DIFFSTAT_TIMEOUT_MS);
    return parseDiffstatBatch(result.stdout);
  }

  private async batchActivity(
    sandbox: WorkspaceSandbox,
    rows: SessionRow[]
  ): Promise<Map<string, SessionActivity>> {
    const dirs = [...new Set(rows.map((r) => r.worktreePath).filter(isWorktreePath))];
    const out = new Map<string, SessionActivity>();
    const nativeDirs = new Set(
      rows.filter((r) => !acpAgentOf(r.agent) || r.opencodeSessionId).map((r) => r.worktreePath)
    );
    const acp = this.acpActivity
      ? this.acpActivity(sandbox, dirs).catch(() => new Map<string, SessionActivity>())
      : Promise.resolve(new Map<string, SessionActivity>());
    await Promise.all(
      dirs
        .filter((dir) => nativeDirs.has(dir))
        .map(async (dir) => {
          try {
            const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session/status', {
              directory: dir,
              timeoutMs: ACTIVITY_TIMEOUT_MS
            });
            if (res.status === 200) out.set(dir, activityFromStatus(res.body));
          } catch {
            return;
          }
        })
    );
    for (const [dir, activity] of await acp) {
      if (activity === 'working' || activity === 'needs_input') out.set(dir, 'working');
    }
    return out;
  }

  private acpActivity:
    | ((sandbox: WorkspaceSandbox, dirs: string[]) => Promise<Map<string, SessionActivity>>)
    | null = null;

  setAcpActivity(
    fn:
      | ((sandbox: WorkspaceSandbox, dirs: string[]) => Promise<Map<string, SessionActivity>>)
      | null
  ): void {
    this.acpActivity = fn;
  }

  private async ownerGithubToken(userId: string): Promise<string | null> {
    return (await this.tokens.getValidUserToken(userId)) || null;
  }

  private async github(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'orchard-greenhouse',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async repoRemote(
    sandbox: WorkspaceSandbox,
    repo: string
  ): Promise<{ owner: string; repo: string } | null> {
    if (sandbox.status !== 'running' || !isValidRepoName(repo)) return null;
    const result = await this.devExec(
      sandbox,
      `git -C ${shellQuote(repoPathFor(repo))} remote get-url origin 2>/dev/null`,
      15_000
    ).catch(() => null);
    return result?.ok ? parseGithubRemote(result.stdout) : null;
  }

  private async issueContext(
    sandbox: WorkspaceSandbox,
    repo: string,
    issue: { provider?: unknown; ref?: unknown } | undefined,
    actorUserId: string
  ): Promise<SessionIssueContext | null> {
    if (!issue || typeof issue.ref !== 'string' || !issue.ref.trim()) return null;
    const ref = issue.ref.trim().slice(0, 300);
    if (issue.provider !== 'github' && issue.provider !== 'linear') {
      throw new BadRequestException('Unknown issue provider');
    }
    const plain = {
      title: null,
      text: `${issue.provider === 'github' ? 'GitHub' : 'Linear'} issue: ${ref}`
    };
    if (this.issueResolver) {
      const resolved = await this.issueResolver({
        sandbox,
        repo,
        actorUserId,
        provider: issue.provider,
        ref
      }).catch((e: any) => {
        if (e instanceof ForbiddenException) throw e;
        this.logger.warn(`issue lookup failed for ${ref}: ${e?.message}`);
        return null;
      });
      return resolved ?? plain;
    }
    if (issue.provider === 'linear') return plain;
    const token = await this.ownerGithubToken(sandbox.userId);
    const parsed = parseIssueRef(ref, await this.repoRemote(sandbox, repo));
    if (!parsed || !token) return { title: null, text: `GitHub issue: ${ref}` };
    try {
      const res = await this.github(
        token,
        `/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`
      );
      if (res.status !== 200 || !res.body?.title) {
        return { title: null, text: `GitHub issue: ${ref}` };
      }
      const body = typeof res.body.body === 'string' ? res.body.body.slice(0, 8000) : '';
      return {
        title: String(res.body.title).slice(0, MAX_TITLE),
        text: `GitHub issue ${parsed.owner}/${parsed.repo}#${parsed.number}: ${res.body.title}\n${res.body.html_url ?? ''}\n\n${body}`.trim()
      };
    } catch {
      return { title: null, text: `GitHub issue: ${ref}` };
    }
  }

  async create(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    body: {
      id?: string;
      repo?: string;
      baseBranch?: string | null;
      title?: string;
      prompt?: string;
      issue?: { provider?: string; ref?: string };
      branchPrefix?: string;
      agent?: string;
    },
    opts: { issue?: SessionIssueContext } = {}
  ): Promise<SessionDto> {
    this.requireRunning(sandbox);
    if (body.id !== undefined && !isUuid(body.id)) {
      throw new BadRequestException('id must be a UUID');
    }
    const requestedId = body.id?.toLowerCase();
    const replay = requestedId
      ? await this.replayedCreate(sandbox, actorUserId, requestedId)
      : null;
    if (replay) return replay;
    const repo = body.repo;
    if (!isValidRepoName(repo)) throw new BadRequestException('Invalid repo name');
    const baseBranch = body.baseBranch ? body.baseBranch : null;
    if (baseBranch !== null && !isValidGitRef(baseBranch)) {
      throw new BadRequestException('Invalid base branch');
    }
    const prefix = body.branchPrefix === undefined ? SESSION_BRANCH_PREFIX : body.branchPrefix;
    if (!isValidBranchPrefix(prefix)) {
      throw new BadRequestException(
        'branchPrefix must be up to 40 letters, digits, dots, dashes, underscores or slashes, and a valid git ref'
      );
    }
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      throw new BadRequestException('prompt must be a string');
    }
    if (body.prompt && body.prompt.length > MAX_PROMPT) {
      throw new BadRequestException('prompt is too long');
    }
    const agent = sessionAgentFor(body.agent);
    const issue = opts.issue ?? (await this.issueContext(sandbox, repo, body.issue, actorUserId));
    const prompt = issue
      ? [issue.text, body.prompt?.trim() || 'Work on this issue.'].join('\n\n')
      : (body.prompt?.trim() ?? '');
    const title = (
      body.title?.trim() ||
      issue?.title ||
      body.prompt?.trim().split('\n')[0] ||
      (await this.freeSessionName(sandbox.id))
    ).slice(0, MAX_TITLE);

    const id = requestedId ?? randomUUID();
    const pooled = await this.createFromPool(sandbox, actorUserId, {
      id,
      repo,
      baseBranch,
      prefix,
      title,
      prompt,
      agent,
      slugHint: issue?.slugHint ?? null
    });
    if (pooled) return pooled;

    let row: SandboxConversation | null = null;
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      const slug = slugify(issue?.slugHint || title, randomBytes(3).toString('hex'));
      const branch = sessionBranch(slug, prefix);
      if (!isValidSlug(slug) || !isValidGitRef(branch)) continue;
      try {
        row = await this.prisma.sandboxConversation.create({
          data: {
            id,
            sandboxId: sandbox.id,
            title,
            repo,
            slug,
            branch,
            worktreePath: worktreePathFor(repo, slug),
            agent,
            createdById: actorUserId
          }
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const raced = requestedId
            ? await this.replayedCreate(sandbox, actorUserId, requestedId)
            : null;
          if (raced) return raced;
          continue;
        }
        throw e;
      }
    }
    if (!row || !row.slug) throw new ConflictException('Could not allocate a session name');

    const created = await this.prisma.sandboxConversation.findUniqueOrThrow({
      where: { id: row.id },
      include: { createdBy: CREATOR_SELECT }
    });
    const chatId = acpAgentOf(agent) ? newAcpChatId() : null;
    void this.prepare(sandbox, actorUserId, created, { repo, baseBranch, title, prompt, chatId });
    const dto = toSessionDto(created, {
      activity: prompt ? 'working' : 'idle',
      agentChatId: chatId
    });
    this.emit(dto);
    return dto;
  }

  private async createFromPool(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    input: {
      id: string;
      repo: string;
      baseBranch: string | null;
      prefix: string;
      title: string;
      prompt: string;
      agent: string;
      slugHint: string | null;
    }
  ): Promise<SessionDto | null> {
    const host = this.agentHost;
    if (!host) return null;
    const branchSlug = slugify(input.slugHint || input.title, randomBytes(3).toString('hex'));
    const branch = sessionBranch(branchSlug, input.prefix);
    if (!isValidSlug(branchSlug) || !isValidGitRef(branch)) return null;
    const acp = acpAgentOf(input.agent);
    const chatId = acp ? newAcpChatId() : null;
    const claim = await host
      .claim(sandbox, {
        repo: input.repo,
        base: input.baseBranch,
        branch,
        agent: acp,
        chatId,
        title: input.title,
        prompt: input.prompt,
        actorUserId
      })
      .catch((e) => {
        this.logger.warn(`pool claim failed for ${sandbox.id}: ${e?.message}`);
        return null;
      });
    if (!claim?.claimed || !isWorktreePath(claim.path) || !claim.commit) {
      void host
        .ensurePool(sandbox, {
          repo: input.repo,
          base: input.baseBranch,
          agent: acp,
          setup: null
        })
        .catch(() => null);
      return null;
    }
    const worktreePath = claim.path;
    const slug = posix.basename(worktreePath);
    let row: SandboxConversation;
    try {
      row = await this.prisma.sandboxConversation.create({
        data: {
          id: input.id,
          sandboxId: sandbox.id,
          title: input.title,
          repo: input.repo,
          slug,
          branch,
          worktreePath,
          baseBranch: claim.base ?? input.baseBranch,
          baseCommit: claim.commit,
          agent: input.agent,
          createdById: actorUserId
        }
      });
    } catch (e) {
      void this.devExec(
        sandbox,
        buildWorktreeRemoveScript(input.repo, slug, input.id, {
          deleteBranch: true,
          purgeState: true,
          branch
        }),
        WORKTREE_TIMEOUT_MS
      ).catch(() => null);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.replayedCreate(sandbox, actorUserId, input.id);
        if (raced) return raced;
      }
      throw e;
    }
    const created = await this.prisma.sandboxConversation.findUniqueOrThrow({
      where: { id: row.id },
      include: { createdBy: CREATOR_SELECT }
    });
    if (acp && chatId) {
      if (claim.chat?.id === chatId) {
        await host
          .adoptChat(sandbox, created, actorUserId, { id: chatId, agent: acp }, input.title)
          .catch((e) => this.logger.warn(`could not record chat ${chatId}: ${e?.message}`));
      } else {
        void host
          .startChat(sandbox, created, actorUserId, {
            id: chatId,
            agent: acp,
            title: input.title,
            prompt: input.prompt
          })
          .catch((e) => this.logger.warn(`chat start failed for ${created.id}: ${e?.message}`));
      }
    } else {
      void this.startNativeChat(sandbox, actorUserId, created, worktreePath, input);
    }
    void this.installCoauthorHook(sandbox, created.id, worktreePath);
    if (claim.setup !== 'done') {
      void this.startScript(sandbox, created, 'setup', { onlyIfConfigured: true }).catch((e) =>
        this.logger.warn(`setup script failed to launch for ${created.id}: ${e?.message}`)
      );
    } else {
      void this.devExec(sandbox, buildPoolSetupAdopt(created.id, claim.name ?? null), 15_000).catch(
        (e) => this.logger.warn(`could not record pooled setup for ${created.id}: ${e?.message}`)
      );
    }
    void this.refillPool(sandbox, created, acp);
    const dto = toSessionDto(created, {
      stats: {
        diffstat: { files: 0, additions: 0, deletions: 0 },
        aheadBehind: { ahead: 0, behind: 0 }
      },
      activity: input.prompt ? 'working' : 'idle',
      agentChatId: chatId
    });
    this.emit(dto);
    return dto;
  }

  private async startNativeChat(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    row: SessionRow,
    worktreePath: string,
    input: { title: string; prompt: string }
  ): Promise<void> {
    try {
      const opencodeSessionId = await this.createOpencodeSession(
        sandbox,
        worktreePath,
        input.title
      );
      if (!opencodeSessionId) {
        if (input.prompt) {
          await this.prisma.sandboxConversation
            .update({
              where: { id: row.id },
              data: { prepareError: 'The agent did not answer, so your prompt was not sent' },
              include: { createdBy: CREATOR_SELECT }
            })
            .then((failed) => this.emit(toSessionDto(failed)))
            .catch(() => null);
        }
        return;
      }
      const saved = await this.prisma.sandboxConversation.update({
        where: { id: row.id },
        data: { opencodeSessionId },
        include: { createdBy: CREATOR_SELECT }
      });
      this.emit(toSessionDto(saved, { activity: input.prompt ? 'working' : 'idle' }));
      if (input.prompt) {
        await this.sendInitialPrompt(
          sandbox,
          actorUserId,
          opencodeSessionId,
          worktreePath,
          input.prompt
        );
      }
    } catch (e: any) {
      this.logger.warn(`native chat start failed for ${row.id}: ${e?.message}`);
    }
  }

  private async refillPool(
    sandbox: WorkspaceSandbox,
    row: SessionRow | SandboxConversation,
    acp: string | null
  ): Promise<void> {
    const host = this.agentHost;
    if (!host || !row.repo) return;
    try {
      const probe = await this.probeScripts(sandbox, row);
      await host.ensurePool(sandbox, {
        repo: row.repo,
        base: row.baseBranch,
        agent: acp,
        setup: probe.config.setup
      });
    } catch (e: any) {
      this.logger.debug(`pool refill for ${row.repo} skipped: ${e?.message}`);
    }
  }

  private async replayedCreate(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    id: string
  ): Promise<SessionDto | null> {
    const existing = await this.prisma.sandboxConversation.findUnique({
      where: { id },
      include: { createdBy: CREATOR_SELECT }
    });
    if (!existing) return null;
    if (
      existing.sandboxId !== sandbox.id ||
      existing.createdById !== actorUserId ||
      !existing.slug
    ) {
      throw new ConflictException('That session id is already in use');
    }
    return toSessionDto(existing);
  }

  private async prepare(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    row: SandboxConversation,
    input: {
      repo: string;
      baseBranch: string | null;
      title: string;
      prompt: string;
      chatId?: string | null;
    }
  ): Promise<void> {
    const slug = row.slug as string;
    const acp = acpAgentOf(row.agent);
    const fail = async (message: string) => {
      const failed = await this.prisma.sandboxConversation
        .update({
          where: { id: row.id },
          data: { prepareError: message.slice(0, 2000) },
          include: { createdBy: CREATOR_SELECT }
        })
        .catch(() => null);
      if (failed) this.emit(toSessionDto(failed));
    };
    try {
      const result = await this.devExec(
        sandbox,
        buildWorktreeAddScript({
          repo: input.repo,
          slug,
          baseBranch: input.baseBranch,
          branch: branchOf(row),
          extra: buildCoauthorHookInlineInstall(row.id, worktreePathFor(input.repo, slug))
        }),
        WORKTREE_TIMEOUT_MS
      ).catch((e) => ({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: String(e?.message ?? '')
      }));
      if (!result.ok) {
        await fail(this.worktreeError(result.exitCode, input.repo, result.stderr));
        return;
      }
      const added = parseWorktreeAddOutput(result.stdout);
      if (!added.baseCommit) {
        await fail('Could not read the starting commit of the new worktree');
        return;
      }
      const worktreePath = worktreePathFor(input.repo, slug);
      const opencodeSessionId = acp
        ? null
        : await this.createOpencodeSession(sandbox, worktreePath, input.title);
      if (!acp && !opencodeSessionId && input.prompt) {
        await fail('The agent did not answer, so your prompt was not sent');
        return;
      }
      const saved = await this.prisma.sandboxConversation
        .update({
          where: { id: row.id },
          data: {
            baseBranch: added.baseBranch,
            baseCommit: added.baseCommit,
            opencodeSessionId
          },
          include: { createdBy: CREATOR_SELECT }
        })
        .catch(async (e) => {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025')) throw e;
          await this.devExec(
            sandbox,
            buildWorktreeRemoveScript(input.repo, slug, row.id, {
              deleteBranch: true,
              purgeState: true,
              branch: branchOf(row)
            }),
            WORKTREE_TIMEOUT_MS
          ).catch(() => null);
          if (opencodeSessionId) {
            await this.workspace
              .opencodeRequest(
                sandbox,
                'DELETE',
                `/session/${encodeURIComponent(opencodeSessionId)}`,
                {
                  directory: worktreePath,
                  timeoutMs: ACTIVITY_TIMEOUT_MS
                }
              )
              .catch(() => null);
          }
          return null;
        });
      if (!saved) return;
      this.emit(
        toSessionDto(saved, {
          stats: {
            diffstat: { files: 0, additions: 0, deletions: 0 },
            aheadBehind: { ahead: 0, behind: 0 }
          },
          activity: input.prompt && (opencodeSessionId || acp) ? 'working' : 'idle',
          agentChatId: input.chatId ?? null
        })
      );
      if (acp && input.chatId && this.agentHost) {
        void this.agentHost
          .startChat(sandbox, saved, actorUserId, {
            id: input.chatId,
            agent: acp,
            title: input.title,
            prompt: input.prompt
          })
          .catch((e) => this.logger.warn(`chat start failed for ${saved.id}: ${e?.message}`));
      }
      void this.refillPool(sandbox, saved, acp);
      if (!added.hookInstalled) {
        void this.installCoauthorHook(sandbox, saved.id, worktreePath);
      }
      if (opencodeSessionId && input.prompt) {
        void this.sendInitialPrompt(
          sandbox,
          actorUserId,
          opencodeSessionId,
          worktreePath,
          input.prompt
        ).catch((e) => this.logger.warn(`initial prompt failed for ${saved.id}: ${e?.message}`));
      }
      void this.startScript(sandbox, saved, 'setup', { onlyIfConfigured: true }).catch((e) =>
        this.logger.warn(`setup script failed to launch for ${saved.id}: ${e?.message}`)
      );
    } catch (e: any) {
      this.logger.warn(`session prepare failed for ${row.id}: ${e?.message}`);
      await fail(e?.message || 'Could not prepare the session');
    }
  }

  async installCoauthorHook(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    worktreePath: string
  ): Promise<boolean> {
    const result = await this.devExec(
      sandbox,
      buildCoauthorHookInstall(sessionId, worktreePath),
      20_000,
      Buffer.from(COAUTHOR_HOOK_SCRIPT, 'utf8')
    ).catch((e) => {
      this.logger.warn(`co-author hook install failed for ${sessionId}: ${e?.message}`);
      return null;
    });
    if (result && !result.ok) {
      this.logger.warn(`co-author hook install exited ${result.exitCode} for ${sessionId}`);
    }
    return !!result?.ok;
  }

  async sendInitialPrompt(
    sandbox: WorkspaceSandbox,
    actorUserId: string,
    chatId: string,
    worktreePath: string,
    text: string
  ): Promise<string> {
    const messageId = newOpencodeMessageId();
    const recorded = this.promptRecorder
      ? this.promptRecorder({
          sandboxId: sandbox.id,
          userId: actorUserId,
          chatId,
          messageId,
          directory: worktreePath,
          fresh: true
        }).catch((e) => {
          this.logger.warn(`initial prompt attribution failed for ${chatId}: ${e?.message}`);
          return false;
        })
      : null;
    const [res] = await Promise.all([
      this.workspace.opencodeRequest(
        sandbox,
        'POST',
        `/session/${encodeURIComponent(chatId)}/prompt_async`,
        {
          directory: worktreePath,
          body: { messageID: messageId, parts: [{ type: 'text', text }] },
          timeoutMs: OPENCODE_CREATE_TIMEOUT_MS
        }
      ),
      recorded
    ]);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`the agent did not accept the first prompt (${res.status})`);
    }
    return messageId;
  }

  private worktreeError(code: number | null, repo: string, stderr: string): string {
    switch (code) {
      case WORKTREE_EXIT.notRepo:
        return `"${repo}" is not a git repository in this sandbox`;
      case WORKTREE_EXIT.exists:
        return 'A worktree for this session already exists';
      case WORKTREE_EXIT.noBase:
        return 'Could not find the base branch in that repository';
      default: {
        const detail = stderr.trim().split('\n').pop()?.slice(0, 200);
        return detail
          ? `Could not create the worktree: ${detail}`
          : 'Could not create the worktree';
      }
    }
  }

  private async createOpencodeSession(
    sandbox: WorkspaceSandbox,
    directory: string,
    title: string
  ): Promise<string | null> {
    try {
      const res = await this.workspace.opencodeRequest(sandbox, 'POST', '/session', {
        directory,
        body: chatTitleFor(title),
        timeoutMs: OPENCODE_CREATE_TIMEOUT_MS
      });
      const id = (res.body as { id?: unknown } | null)?.id;
      if (res.status >= 200 && res.status < 300 && typeof id === 'string' && id.length <= 255) {
        return id;
      }
      this.logger.warn(`opencode session create returned ${res.status} for ${sandbox.id}`);
    } catch (e: any) {
      this.logger.warn(`opencode session create failed for ${sandbox.id}: ${e?.message}`);
    }
    return null;
  }

  async update(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    body: { title?: string; archived?: boolean; deleteBranch?: boolean }
  ): Promise<SessionDto> {
    if (body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') {
      throw new BadRequestException('deleteBranch must be a boolean');
    }
    if (body.deleteBranch === true && body.archived !== true) {
      throw new BadRequestException('deleteBranch only applies when archiving');
    }
    const row = await this.row(sandbox.id, sessionId);
    const data: Prisma.SandboxConversationUpdateInput = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') throw new BadRequestException('title must be a string');
      const title = body.title.trim().slice(0, MAX_TITLE);
      if (!title) throw new BadRequestException('Title must not be empty');
      data.title = title;
    }
    if (body.archived !== undefined && body.archived !== !!row.archivedAt) {
      if (typeof body.archived !== 'boolean') {
        throw new BadRequestException('archived must be a boolean');
      }
      if (body.archived) {
        if (sandbox.status === 'running' && row.repo && row.slug) {
          await this.devExec(
            sandbox,
            buildWorktreeRemoveScript(row.repo, row.slug, row.id, {
              deleteBranch: body.deleteBranch === true,
              branch: branchOf(row)
            }),
            WORKTREE_TIMEOUT_MS
          ).catch((e) => this.logger.warn(`worktree remove failed for ${row.id}: ${e?.message}`));
        }
        data.archivedAt = new Date();
      } else {
        this.requireRunning(sandbox);
        if (!row.repo || !row.slug) throw new BadRequestException('This session has no worktree');
        const result = await this.devExec(
          sandbox,
          buildWorktreeRestoreScript(row.repo, row.slug, branchOf(row)),
          WORKTREE_TIMEOUT_MS
        );
        if (!result.ok) {
          throw new BadRequestException(
            this.worktreeError(result.exitCode, row.repo, result.stderr)
          );
        }
        await this.installCoauthorHook(sandbox, row.id, worktreePathFor(row.repo, row.slug));
        data.archivedAt = null;
      }
    }
    const saved = await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data,
      include: { createdBy: CREATOR_SELECT }
    });
    const [dto] = await this.decorate(sandbox, [saved]);
    this.emit(dto);
    if (body.archived === true && !row.archivedAt) this.previewTeardown(sandbox, saved, 'archived');
    return dto;
  }

  async remove(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    opts: { deleteBranch?: boolean } = {}
  ): Promise<void> {
    const row = await this.row(sandbox.id, sessionId);
    if (sandbox.status === 'running') {
      if (row.repo && row.slug) {
        const script = buildWorktreeRemoveScript(row.repo, row.slug, row.id, {
          deleteBranch: opts.deleteBranch,
          purgeState: true,
          branch: branchOf(row)
        });
        await this.devExec(sandbox, script, WORKTREE_TIMEOUT_MS).catch((e) =>
          this.logger.warn(`worktree cleanup failed for ${row.id}: ${e?.message}`)
        );
      }
      if (row.opencodeSessionId) {
        await this.workspace
          .opencodeRequest(
            sandbox,
            'DELETE',
            `/session/${encodeURIComponent(row.opencodeSessionId)}`,
            { directory: row.worktreePath, timeoutMs: ACTIVITY_TIMEOUT_MS }
          )
          .catch(() => null);
      }
    }
    await this.prisma.sandboxConversation.delete({ where: { id: row.id } });
    this.previewTeardown(sandbox, row, 'deleted');
    try {
      this.events.emit('session-deleted', sandbox.id, row.id);
    } catch (e: any) {
      this.logger.warn(`session listener failed: ${e?.message}`);
    }
  }

  async titleFromPrompt(input: {
    sandbox: WorkspaceSandbox;
    sessionId?: string | null;
    chatId?: string | null;
    directory?: string | null;
    text: string;
    agentTitles?: boolean;
  }): Promise<void> {
    const or: Prisma.SandboxConversationWhereInput[] = [];
    if (input.sessionId) or.push({ id: input.sessionId });
    if (input.chatId) or.push({ opencodeSessionId: input.chatId });
    if (input.directory) {
      or.push({ worktreePath: input.directory });
      const key = worktreeKeyOf(input.directory);
      if (key) or.push(key);
    }
    if (or.length === 0) return;
    const row = await this.prisma.sandboxConversation.findFirst({
      where: { sandboxId: input.sandbox.id, archivedAt: null, OR: or },
      select: { id: true, title: true }
    });
    if (!row || !isGeneratedSessionName(row.title)) return;
    const title = promptTitle(input.text)?.slice(0, MAX_TITLE);
    if (!title || !(await this.retitle(input.sandbox, row.id, row.title, title))) return;
    if (input.agentTitles && input.chatId) {
      this.adoptAgentTitle(input.sandbox, row.id, input.chatId, input.directory ?? null, title);
    }
  }

  private async retitle(
    sandbox: WorkspaceSandbox,
    id: string,
    from: string,
    to: string
  ): Promise<boolean> {
    if (from === to) return false;
    const { count } = await this.prisma.sandboxConversation.updateMany({
      where: { id, title: from },
      data: { title: to }
    });
    if (count === 0) return false;
    const saved = await this.prisma.sandboxConversation.findUnique({
      where: { id },
      include: { createdBy: CREATOR_SELECT }
    });
    if (saved) {
      const [dto] = await this.decorate(sandbox, [saved]);
      this.emit(dto);
    }
    return true;
  }

  private adoptAgentTitle(
    sandbox: WorkspaceSandbox,
    id: string,
    chatId: string,
    directory: string | null,
    current: string
  ): void {
    const look = async (): Promise<boolean> => {
      const res = await this.workspace
        .opencodeRequest(sandbox, 'GET', `/session/${encodeURIComponent(chatId)}`, {
          directory
        })
        .catch(() => null);
      const title = (res?.body as { title?: unknown } | null)?.title;
      if (res?.status !== 200 || !isAgentTitle(title)) return false;
      await this.retitle(sandbox, id, current, title.trim().slice(0, MAX_TITLE));
      return true;
    };
    const run = async () => {
      for (const delay of AGENT_TITLE_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
        if (await look()) return;
      }
    };
    run().catch(() => null);
  }

  private async freeSessionName(sandboxId: string): Promise<string> {
    const rows = await this.prisma.sandboxConversation.findMany({
      where: { sandboxId, archivedAt: null },
      select: { title: true }
    });
    return pickSessionName(rows.map((r) => r.title ?? ''));
  }

  async removeRepo(
    sandbox: WorkspaceSandbox,
    repo: string
  ): Promise<{ name: string; sessions: number }> {
    if (!isValidRepoName(repo)) throw new BadRequestException('Invalid repository name');
    this.requireRunning(sandbox);
    const found = await this.devExec(sandbox, `[ -e ${shellQuote(repoPathFor(repo))}/.git ]`);
    if (!found.ok) throw new NotFoundException(`No repository named "${repo}" on this machine`);
    const rows = await this.prisma.sandboxConversation.findMany({
      where: { sandboxId: sandbox.id, repo, slug: { not: null } },
      select: { id: true }
    });
    for (const row of rows) await this.remove(sandbox, row.id);
    const result = await this.devExec(sandbox, buildRepoRemoveScript(repo), WORKTREE_TIMEOUT_MS);
    if (!result.ok && result.exitCode !== 4)
      throw new BadRequestException('Could not remove the repository');
    return { name: repo, sessions: rows.length };
  }

  async chats(
    sandbox: WorkspaceSandbox,
    sessionId: string
  ): Promise<{ chats: Array<{ id: string; title: string; createdAt: string | null }> }> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session', {
      directory: row.worktreePath
    });
    if (res.status !== 200 || !Array.isArray(res.body)) return { chats: [] };
    const chats = (res.body as any[])
      .filter(
        (s) =>
          s &&
          typeof s.id === 'string' &&
          !s.parentID &&
          (inWorktree(s.directory, row.worktreePath) || s.id === row.opencodeSessionId)
      )
      .map((s) => ({
        id: s.id as string,
        title: typeof s.title === 'string' ? s.title : 'Chat',
        created: typeof s.time?.created === 'number' ? s.time.created : null
      }))
      .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.created !== null ? new Date(c.created).toISOString() : null
      }));
    return { chats };
  }

  async deleteChat(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string
  ): Promise<{ success: true; remaining: number }> {
    if (!/^ses_[A-Za-z0-9]{1,60}$/.test(chatId)) throw new BadRequestException('Invalid chat');
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const { chats } = await this.chats(sandbox, sessionId);
    if (!chats.some((c) => c.id === chatId)) {
      if (row.opencodeSessionId === chatId) {
        await this.prisma.sandboxConversation
          .update({ where: { id: row.id }, data: { opencodeSessionId: chats[0]?.id ?? null } })
          .catch(() => {});
      }
      return { success: true, remaining: chats.length };
    }
    const res = await this.workspace.opencodeRequest(sandbox, 'DELETE', `/session/${chatId}`, {
      directory: row.worktreePath
    });
    if (res.status >= 300 && res.status !== 404) {
      throw new BadRequestException('The agent could not delete that chat');
    }
    const remaining = chats.filter((c) => c.id !== chatId);
    if (row.opencodeSessionId === chatId) {
      await this.prisma.sandboxConversation
        .update({
          where: { id: row.id },
          data: { opencodeSessionId: remaining[0]?.id ?? null }
        })
        .catch(() => {});
    }
    return { success: true, remaining: remaining.length };
  }

  async createChat(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    body: { title?: string }
  ): Promise<{ id: string; title: string }> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE)
        : 'New chat';
    const res = await this.workspace.opencodeRequest(sandbox, 'POST', '/session', {
      directory: row.worktreePath,
      body: { title },
      timeoutMs: OPENCODE_CREATE_TIMEOUT_MS
    });
    const id = (res.body as { id?: unknown } | null)?.id;
    if (res.status < 200 || res.status >= 300 || typeof id !== 'string') {
      throw new BadRequestException('The agent could not start a new chat');
    }
    if (!row.opencodeSessionId) {
      await this.prisma.sandboxConversation
        .update({ where: { id: row.id }, data: { opencodeSessionId: id } })
        .catch(() => {});
    }
    return {
      id,
      title: typeof (res.body as any)?.title === 'string' ? (res.body as any).title : title
    };
  }

  private async probeScripts(
    sandbox: WorkspaceSandbox,
    row: SessionRow | SandboxConversation
  ): Promise<{
    config: GreenhouseConfig;
    setupStatus: string | null;
    runPaneDead: string | null;
    running: string[];
  }> {
    const nonce = randomBytes(6).toString('hex');
    const result = await this.devExec(
      sandbox,
      buildScriptsProbe(row.id, row.worktreePath ?? '', repoPathFor(row.repo ?? ''), nonce),
      20_000
    );
    const probe = parseScriptsProbe(result.stdout, nonce);
    const config = parseGreenhouseConfig(probe.configText);
    if (config.ports.length) {
      void this.recordDeclaredPorts(sandbox, config.ports).catch((e) =>
        this.logger.warn(`could not record declared ports for ${sandbox.id}: ${e?.message}`)
      );
    }
    return {
      config,
      setupStatus: probe.setupStatus,
      runPaneDead: probe.runPaneDead,
      running: probe.running
    };
  }

  async recordDeclaredPorts(sandbox: WorkspaceSandbox, ports: number[]): Promise<number[]> {
    const current = await this.prisma.sandbox.findUnique({
      where: { id: sandbox.id },
      select: { runnerState: true }
    });
    if (!current) return [];
    const existing = declaredPreviewPorts(current.runnerState);
    const merged = mergeDeclaredPorts(existing, ports);
    if (merged.length === existing.length && merged.every((p) => existing.includes(p))) {
      return existing;
    }
    const state =
      current.runnerState &&
      typeof current.runnerState === 'object' &&
      !Array.isArray(current.runnerState)
        ? (current.runnerState as Record<string, unknown>)
        : {};
    await this.prisma.sandbox.updateMany({
      where: { id: sandbox.id },
      data: { runnerState: { ...state, declaredPorts: merged } }
    });
    const runner = this.registry.for(sandbox);
    if (runner.requestPreviewPorts) {
      await runner.requestPreviewPorts(
        { ...refOf(sandbox), runnerState: { ...state, declaredPorts: merged } },
        merged
      );
    }
    return merged;
  }

  async scripts(sandbox: WorkspaceSandbox, sessionId: string): Promise<SessionScriptsDto> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const probe = await this.probeScripts(sandbox, row);
    const live = new Set(probe.running);
    const commands = probe.config.commands.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      running: live.has(scriptNameOf(c.id))
    }));
    return {
      setup: probe.config.setup,
      run: probe.config.run,
      ports: probe.config.ports,
      commands,
      setupState: setupStateOf(probe.setupStatus),
      running: commands[0]?.running ?? false
    };
  }

  private async startScript(
    sandbox: WorkspaceSandbox,
    row: SessionRow | SandboxConversation,
    name: string,
    opts: { onlyIfConfigured?: boolean } = {}
  ): Promise<boolean> {
    if (!row.repo || !isWorktreePath(row.worktreePath)) return false;
    const probe = await this.probeScripts(sandbox, row);
    const command =
      name === 'setup' ? null : probe.config.commands.find((c) => scriptNameOf(c.id) === name);
    const script = name === 'setup' ? probe.config.setup : (command?.script ?? null);
    if (!script) {
      if (opts.onlyIfConfigured) return false;
      throw new BadRequestException(
        name === 'setup'
          ? 'No setup script in .orchard/greenhouse.json'
          : 'That command is not in .orchard/greenhouse.json'
      );
    }
    const launch = {
      name,
      label: name === 'setup' ? 'setup script' : (command?.label ?? 'run script'),
      sessionId: row.id,
      worktreePath: row.worktreePath,
      repoPath: repoPathFor(row.repo)
    };
    const files = scriptFiles(launch);
    await this.registry.for(sandbox).writeFiles(
      refOf(sandbox),
      [
        { path: files.userPath, content: Buffer.from(`${script}\n`, 'utf8') },
        { path: files.wrapperPath, content: Buffer.from(files.wrapper, 'utf8') }
      ],
      { asUser: 'dev' }
    );
    const result = await this.devExec(sandbox, buildScriptLaunch(launch), 20_000);
    if (!result.ok) throw new BadRequestException(`Could not start the ${name} script`);
    return true;
  }

  async run(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    action: unknown,
    command: unknown = 'run'
  ): Promise<SessionScriptsDto> {
    if (action !== 'start' && action !== 'stop') {
      throw new BadRequestException("action must be 'start' or 'stop'");
    }
    if (command !== undefined && command !== null && typeof command !== 'string') {
      throw new BadRequestException('command must be a string');
    }
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const name = await this.scriptNameFor(sandbox, row, command ?? null);
    if (action === 'start') {
      await this.startScript(sandbox, row, name);
    } else {
      await this.devExec(sandbox, buildScriptStop(row.id, name), 15_000);
    }
    return this.scripts(sandbox, sessionId);
  }

  private async scriptNameFor(
    sandbox: WorkspaceSandbox,
    row: SessionRow | SandboxConversation,
    command: string | null
  ): Promise<string> {
    if (command === 'setup') return 'setup';
    if (!command || command === 'run') {
      const probe = await this.probeScripts(sandbox, row);
      const first = probe.config.commands[0];
      return first ? scriptNameOf(first.id) : 'run';
    }
    const name = scriptNameOf(command.trim().toLowerCase());
    if (!isScriptName(name)) throw new BadRequestException('Unknown command');
    return name;
  }

  async ports(
    sandbox: WorkspaceSandbox,
    sessionId: string
  ): Promise<{
    previewPorts: number[];
    ports: Array<{
      port: number;
      process: string | null;
      previewUrl: string | null;
      exposable: boolean;
      public: boolean;
      inSession: boolean;
      loopbackOnly: boolean;
      listening: boolean;
      declared: boolean;
    }>;
  }> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const runner = this.registry.for(sandbox);
    const [result, declared] = await Promise.all([
      runner.exec(refOf(sandbox), ['su', 'dev', '-s', '/bin/sh', '-c', buildPortsScript()], {
        timeoutMs: 15_000
      }),
      this.probeScripts(sandbox, row).then(
        (probe) => probe.config.ports,
        () => [] as number[]
      )
    ]);
    const previews = runner.capabilities.previews;
    const previewPorts = previewablePorts(
      previews,
      mergeDeclaredPorts(declaredPreviewPorts(sandbox.runnerState), declared)
    );
    const exposure = (port: number) => {
      const exposable = previewPorts.includes(port);
      return { exposable, public: exposable && previews === 'public' };
    };
    const listening = parsePortsOutput(result.stdout, row.worktreePath).map((p) => ({
      port: p.port,
      process: p.process,
      previewUrl: null,
      ...exposure(p.port),
      inSession: p.inSession,
      loopbackOnly: p.loopbackOnly,
      listening: true,
      declared: declared.includes(p.port)
    }));
    const seen = new Set(listening.map((p) => p.port));
    const waiting = declared
      .filter((port) => !seen.has(port))
      .map((port) => ({
        port,
        process: null,
        previewUrl: null,
        ...exposure(port),
        inSession: false,
        loopbackOnly: false,
        listening: false,
        declared: true
      }));
    return {
      previewPorts,
      ports: [...listening, ...waiting].sort((a, b) => a.port - b.port)
    };
  }

  private async prTarget(
    sandbox: WorkspaceSandbox,
    row: SessionRow
  ): Promise<{ owner: string; repo: string; number: number | null } | null> {
    const fromUrl = parsePrUrl(row.prUrl);
    if (fromUrl) return fromUrl;
    const remote = row.repo ? await this.repoRemote(sandbox, row.repo) : null;
    return remote ? { ...remote, number: row.prNumber ?? null } : null;
  }

  async checks(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    actorToken: string | null = null
  ): Promise<SessionChecksDto> {
    const row = await this.row(sandbox.id, sessionId);
    const token = actorToken || (await this.ownerGithubToken(sandbox.userId));
    if (!token) throw new BadRequestException('No GitHub account is linked to read checks');
    const target = await this.prTarget(sandbox, row);
    if (!target) return { pr: null, checks: [] };
    const { owner, repo } = target;
    let pr: any = null;
    if (target.number) {
      const res = await this.github(token, `/repos/${owner}/${repo}/pulls/${target.number}`);
      if (res.status === 200) pr = res.body;
    } else if (row.branch && isValidGitRef(row.branch)) {
      const res = await this.github(
        token,
        `/repos/${owner}/${repo}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${row.branch}`)}`
      );
      if (res.status === 200 && Array.isArray(res.body) && res.body[0]) pr = res.body[0];
    }
    if (!pr || typeof pr.head?.sha !== 'string') return { pr: null, checks: [] };
    const state: PrState = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    if (
      row.prState !== state ||
      row.prNumber !== pr.number ||
      (!row.prUrl && typeof pr.html_url === 'string')
    ) {
      await this.prisma.sandboxConversation
        .update({
          where: { id: row.id },
          data: { prState: state, prNumber: pr.number, prUrl: String(pr.html_url).slice(0, 500) }
        })
        .catch(() => {});
    }
    const sha = pr.head.sha as string;
    const [runsRes, statusRes] = await Promise.all([
      this.github(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`),
      this.github(token, `/repos/${owner}/${repo}/commits/${sha}/status`)
    ]);
    const checks: SessionCheckDto[] = [];
    const failedRuns: Array<{ check: SessionCheckDto; run: any }> = [];
    if (runsRes.status === 200 && Array.isArray(runsRes.body?.check_runs)) {
      for (const run of runsRes.body.check_runs) {
        const check: SessionCheckDto = {
          name: String(run.name ?? 'check'),
          status: String(run.status ?? 'queued'),
          conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
          url: typeof run.html_url === 'string' ? run.html_url : null
        };
        checks.push(check);
        if (check.conclusion && FAILED_CONCLUSIONS.has(check.conclusion)) {
          failedRuns.push({ check, run });
        }
      }
    }
    if (statusRes.status === 200 && Array.isArray(statusRes.body?.statuses)) {
      for (const status of statusRes.body.statuses) {
        const s = String(status.state ?? 'pending');
        checks.push({
          name: String(status.context ?? 'status'),
          status: s === 'pending' ? 'in_progress' : 'completed',
          conclusion: s === 'pending' ? null : s,
          url: typeof status.target_url === 'string' ? status.target_url : null,
          ...(s === 'failure' || s === 'error'
            ? { logExcerpt: String(status.description ?? '').slice(0, LOG_EXCERPT_BYTES) }
            : {})
        });
      }
    }
    await Promise.all(
      failedRuns.slice(0, MAX_FAILED_LOGS).map(async ({ check, run }) => {
        check.logExcerpt = await this.checkRunExcerpt(token, owner, repo, run);
      })
    );
    return {
      pr: {
        number: pr.number,
        url: pr.html_url,
        title: String(pr.title ?? ''),
        state,
        draft: !!pr.draft,
        mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
        mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
        headSha: sha,
        headBranch: String(pr.head?.ref ?? ''),
        baseBranch: String(pr.base?.ref ?? '')
      },
      checks
    };
  }

  private async checkRunExcerpt(
    token: string,
    owner: string,
    repo: string,
    run: any
  ): Promise<string | undefined> {
    const fallback = [run.output?.title, run.output?.summary, run.output?.text]
      .filter((v) => typeof v === 'string' && v.trim())
      .join('\n\n');
    if (run.app?.slug === 'github-actions' && Number.isInteger(run.id)) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${run.id}/logs`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'orchard-greenhouse'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
          }
        );
        if (res.ok) {
          const text = await res.text();
          const excerpt = excerptLog(text);
          if (excerpt) return excerpt;
        }
      } catch {
        return fallback ? excerptLog(fallback) : undefined;
      }
    }
    return fallback ? excerptLog(fallback) : undefined;
  }

  async merge(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    githubToken: string | null,
    method: unknown
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const mergeMethod = method === undefined || method === null ? 'squash' : method;
    if (mergeMethod !== 'squash' && mergeMethod !== 'rebase') {
      throw new BadRequestException("method must be 'squash' or 'rebase'");
    }
    if (!githubToken) throw new BadRequestException('No GitHub account is linked to your user');
    const row = await this.row(sandbox.id, sessionId);
    const target = parsePrUrl(row.prUrl);
    if (!target) throw new BadRequestException('This session has no pull request yet');
    const res = await this.github(
      githubToken,
      `/repos/${target.owner}/${target.repo}/pulls/${target.number}/merge`,
      { method: 'PUT', body: { merge_method: mergeMethod } }
    );
    if (res.status !== 200 || !res.body?.merged) {
      throw new BadRequestException(
        res.body?.message
          ? `GitHub refused the merge: ${res.body.message}`
          : 'GitHub refused the merge'
      );
    }
    const saved = await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data: { prState: 'merged' },
      include: { createdBy: CREATOR_SELECT }
    });
    this.emit(toSessionDto(saved));
    return {
      merged: true,
      sha: typeof res.body.sha === 'string' ? res.body.sha : null,
      message: String(res.body.message ?? 'Pull request merged')
    };
  }
}
