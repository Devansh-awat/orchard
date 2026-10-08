import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { Prisma, type SandboxConversation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
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
  buildScriptLaunch,
  buildScriptStop,
  buildScriptsProbe,
  buildWorktreeAddScript,
  buildWorktreeRemoveScript,
  buildWorktreeRestoreScript,
  isUuid,
  isValidGitRef,
  isValidRepoName,
  isValidSlug,
  isWorktreePath,
  parseDiffstatBatch,
  parseGreenhouseConfig,
  parsePortsOutput,
  parseScriptsProbe,
  parseWorktreeAddOutput,
  repoPathFor,
  scriptFiles,
  sessionBranch,
  setupStateOf,
  shellQuote,
  slugify,
  worktreePathFor,
  type GreenhouseConfig,
  type SessionGitStats,
  type SetupState
} from './sandbox-session-commands';

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
  agent: 'opencode';
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
}

export interface SessionScriptsDto extends GreenhouseConfig {
  setupState: SetupState;
  running: boolean;
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
const GITHUB_TIMEOUT_MS = 10_000;
const MAX_FAILED_LOGS = 3;
const LOG_EXCERPT_LINES = 60;
const LOG_EXCERPT_BYTES = 6000;
const MAX_TITLE = 120;
const MAX_PROMPT = 32768;
const GH_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export function displayName(user: SessionRow['createdBy']): string {
  if (!user) return 'Unknown';
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.username;
}

export function toSessionDto(
  row: SessionRow,
  extras: {
    activity?: SessionActivity;
    stats?: SessionGitStats | null;
    preview?: PreviewSnapshot | null;
  } = {}
): SessionDto {
  const prState =
    row.prState === 'open' || row.prState === 'merged' || row.prState === 'closed'
      ? row.prState
      : null;
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
    agent: 'opencode',
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
    archivedAt: row.archivedAt
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
    private readonly crypto: SecretCryptoService
  ) {
    this.events.setMaxListeners(0);
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

  private devExec(sandbox: WorkspaceSandbox, script: string, timeoutMs = 30_000) {
    return this.registry
      .for(sandbox)
      .exec(refOf(sandbox), ['su', '-l', 'dev', '-c', script], { timeoutMs });
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
    const previews = await this.previewSnapshots(rows);
    const active = rows.filter((r) => !r.archivedAt && isWorktreePath(r.worktreePath));
    if (sandbox.status !== 'running' || active.length === 0) {
      return rows.map((r) => toSessionDto(r, { preview: previews.get(r.id) }));
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
        preview: previews.get(r.id)
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
    await Promise.all(
      dirs.map(async (dir) => {
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
    return out;
  }

  private async ownerGithubToken(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessToken: true }
    });
    return this.crypto.open(user?.githubAccessToken) || null;
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
      repo?: string;
      baseBranch?: string | null;
      title?: string;
      prompt?: string;
      issue?: { provider?: string; ref?: string };
    },
    opts: { issue?: SessionIssueContext } = {}
  ): Promise<SessionDto> {
    this.requireRunning(sandbox);
    const repo = body.repo;
    if (!isValidRepoName(repo)) throw new BadRequestException('Invalid repo name');
    const baseBranch = body.baseBranch ? body.baseBranch : null;
    if (baseBranch !== null && !isValidGitRef(baseBranch)) {
      throw new BadRequestException('Invalid base branch');
    }
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      throw new BadRequestException('prompt must be a string');
    }
    if (body.prompt && body.prompt.length > MAX_PROMPT) {
      throw new BadRequestException('prompt is too long');
    }
    const issue = opts.issue ?? (await this.issueContext(sandbox, repo, body.issue, actorUserId));
    const prompt = issue
      ? [issue.text, body.prompt?.trim() || 'Work on this issue.'].join('\n\n')
      : (body.prompt?.trim() ?? '');
    const title = (
      body.title?.trim() ||
      issue?.title ||
      body.prompt?.trim().split('\n')[0] ||
      'New session'
    ).slice(0, MAX_TITLE);

    let row: SandboxConversation | null = null;
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      const slug = slugify(issue?.slugHint || title, randomBytes(3).toString('hex'));
      if (!isValidSlug(slug)) continue;
      try {
        row = await this.prisma.sandboxConversation.create({
          data: {
            sandboxId: sandbox.id,
            title,
            repo,
            slug,
            branch: sessionBranch(slug),
            worktreePath: worktreePathFor(repo, slug),
            agent: 'opencode',
            createdById: actorUserId
          }
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    if (!row || !row.slug) throw new ConflictException('Could not allocate a session name');

    const result = await this.devExec(
      sandbox,
      buildWorktreeAddScript({ repo, slug: row.slug, baseBranch }),
      WORKTREE_TIMEOUT_MS
    ).catch((e) => {
      if (e instanceof SandboxNotRunningError) throw e;
      return { ok: false, exitCode: null, stdout: '', stderr: String(e?.message ?? '') };
    });
    if (!result.ok) {
      await this.prisma.sandboxConversation.delete({ where: { id: row.id } }).catch(() => {});
      throw new BadRequestException(this.worktreeError(result.exitCode, repo, result.stderr));
    }
    const added = parseWorktreeAddOutput(result.stdout);
    const worktreePath = worktreePathFor(repo, row.slug);
    const opencodeSessionId = await this.createOpencodeSession(sandbox, worktreePath, title);
    const saved = await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data: {
        baseBranch: added.baseBranch,
        baseCommit: added.baseCommit,
        opencodeSessionId
      },
      include: { createdBy: CREATOR_SELECT }
    });
    if (opencodeSessionId && prompt) {
      void this.workspace
        .opencodeRequest(
          sandbox,
          'POST',
          `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
          {
            directory: worktreePath,
            body: { parts: [{ type: 'text', text: prompt }] },
            timeoutMs: OPENCODE_CREATE_TIMEOUT_MS
          }
        )
        .catch((e) => this.logger.warn(`initial prompt failed for ${row?.id}: ${e?.message}`));
    }
    void this.startScript(sandbox, saved, 'setup', { onlyIfConfigured: true }).catch((e) =>
      this.logger.warn(`setup script failed to launch for ${saved.id}: ${e?.message}`)
    );
    const dto = toSessionDto(saved, {
      stats: {
        diffstat: { files: 0, additions: 0, deletions: 0 },
        aheadBehind: { ahead: 0, behind: 0 }
      },
      activity: prompt && opencodeSessionId ? 'working' : 'idle'
    });
    this.emit(dto);
    return dto;
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
        body: { title },
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
    body: { title?: string; archived?: boolean }
  ): Promise<SessionDto> {
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
            buildWorktreeRemoveScript(row.repo, row.slug, row.id),
            WORKTREE_TIMEOUT_MS
          ).catch((e) => this.logger.warn(`worktree remove failed for ${row.id}: ${e?.message}`));
        }
        data.archivedAt = new Date();
      } else {
        this.requireRunning(sandbox);
        if (!row.repo || !row.slug) throw new BadRequestException('This session has no worktree');
        const result = await this.devExec(
          sandbox,
          buildWorktreeRestoreScript(row.repo, row.slug),
          WORKTREE_TIMEOUT_MS
        );
        if (!result.ok) {
          throw new BadRequestException(
            this.worktreeError(result.exitCode, row.repo, result.stderr)
          );
        }
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
          purgeState: true
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
          (s.directory === row.worktreePath || s.id === row.opencodeSessionId)
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
  ): Promise<{ config: GreenhouseConfig; setupStatus: string | null; runPaneDead: string | null }> {
    const nonce = randomBytes(6).toString('hex');
    const result = await this.devExec(
      sandbox,
      buildScriptsProbe(row.id, row.worktreePath ?? '', repoPathFor(row.repo ?? ''), nonce),
      20_000
    );
    const probe = parseScriptsProbe(result.stdout, nonce);
    return {
      config: parseGreenhouseConfig(probe.configText),
      setupStatus: probe.setupStatus,
      runPaneDead: probe.runPaneDead
    };
  }

  async scripts(sandbox: WorkspaceSandbox, sessionId: string): Promise<SessionScriptsDto> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const probe = await this.probeScripts(sandbox, row);
    return {
      ...probe.config,
      setupState: setupStateOf(probe.setupStatus),
      running: probe.runPaneDead === '0'
    };
  }

  private async startScript(
    sandbox: WorkspaceSandbox,
    row: SessionRow | SandboxConversation,
    name: 'setup' | 'run',
    opts: { onlyIfConfigured?: boolean } = {}
  ): Promise<boolean> {
    if (!row.repo || !isWorktreePath(row.worktreePath)) return false;
    const probe = await this.probeScripts(sandbox, row);
    const script = probe.config[name];
    if (!script) {
      if (opts.onlyIfConfigured) return false;
      throw new BadRequestException(`No ${name} script in .orchard/greenhouse.json`);
    }
    const launch = {
      name,
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
    action: unknown
  ): Promise<SessionScriptsDto> {
    if (action !== 'start' && action !== 'stop') {
      throw new BadRequestException("action must be 'start' or 'stop'");
    }
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    if (action === 'start') {
      await this.startScript(sandbox, row, 'run');
    } else {
      await this.devExec(sandbox, buildScriptStop(row.id, 'run'), 15_000);
    }
    return this.scripts(sandbox, sessionId);
  }

  async ports(
    sandbox: WorkspaceSandbox,
    sessionId: string
  ): Promise<{
    ports: Array<{
      port: number;
      process: string | null;
      previewUrl: string | null;
      public: boolean;
      inSession: boolean;
      loopbackOnly: boolean;
    }>;
  }> {
    const row = await this.activeRow(sandbox.id, sessionId);
    this.requireRunning(sandbox);
    const runner = this.registry.for(sandbox);
    const result = await runner.exec(refOf(sandbox), ['/bin/sh', '-c', buildPortsScript()], {
      timeoutMs: 15_000
    });
    const isPublic = runner.capabilities.previews === 'public';
    return {
      ports: parsePortsOutput(result.stdout, row.worktreePath).map((p) => ({
        port: p.port,
        process: p.process,
        previewUrl: null,
        public: isPublic,
        inSession: p.inSession,
        loopbackOnly: p.loopbackOnly
      }))
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
