import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Duplex, PassThrough, Writable } from 'stream';
import WebSocket, { createWebSocketStream } from 'ws';
import type * as VercelSandboxModule from '@vercel/sandbox' with { 'resolution-mode': 'import' };
import type { SandboxDesiredState, SandboxStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { SANDBOX_RUNNERS } from '../../instance-config/instance-config.sections';
import { InstanceSettingsService } from '../../instance-settings/instance-settings.service';
import { ApplyQueueService } from '../../apply/apply-queue.service';
import { ApplyExecutorService, ApplyItemInput } from '../../apply/apply-executor.service';
import { INSTANCE_SETTING_KEY } from '../sandbox-cr';
import { SANDBOX_PHASE_FILE, defaultBridgeBinaryUrl } from '../sandbox-bootstrap';
import { BridgeChecksumResolver } from './bridge-checksum';
import {
  ExecOptions,
  ExecResult,
  ExecStream,
  HttpTarget,
  PtyHandle,
  PtyOptions,
  ReadFileOptions,
  ReadFileResult,
  RunnerObservation,
  SANDBOX_REF_SELECT,
  SandboxFileWrite,
  SandboxNotRunningError,
  SandboxRef,
  SandboxRunner,
  SandboxRunnerCapabilities,
  SandboxSecrets,
  WriteFilesOptions,
  forkSourceOf
} from './sandbox-runner';
import { SandboxSecretsService, deriveSandboxSecret } from './sandbox-secrets';
import { SECRET_INIT_FILES, opencodeBasicAuth, stagedInitFiles } from './sandbox-init-files';
import { deriveObservedStatus } from './sandbox-status';

export const VERCEL_OP_PROVISION = 'vercel.provision';
export const VERCEL_OP_START = 'vercel.start';
export const VERCEL_OP_STOP = 'vercel.stop';
export const VERCEL_OP_DESTROY = 'vercel.destroy';
export const VERCEL_OP_SECRET = 'vercel.secret.sync';
export const VERCEL_OP_FORK = 'vercel.fork';

export const vercelLifecycleKey = (id: string) => `sandbox:${id}:vercel`;
export const vercelSecretKey = (id: string) => `sandbox:${id}:vercel.secret`;
export const vercelDestroyKey = (id: string) => `sandbox:${id}:vercel.destroy`;

export const VERCEL_OPENCODE_PORT = 4096;
export const VERCEL_BRIDGE_PORT = 2222;
export const VERCEL_PREVIEW_PORTS: readonly number[] = [3000, 3001, 4173, 5173, 8000, 8080, 8787];
export const VERCEL_MAX_PORTS = 15;
export const VERCEL_INIT_STAGE = '/tmp/orchard-init';
export const VERCEL_PERSIST_ROOT = '/vercel/sandbox/orchard';
export const VERCEL_DEFAULT_IMAGE = 'vercel/sandbox/universal';
export const VERCEL_PROVIDER_STOPPED = 'Stopped by provider timeout';
export const VERCEL_SANDBOX_GONE = 'The Vercel sandbox no longer exists';
export const VERCEL_SANDBOX_FAILED = 'The Vercel sandbox failed';

const DEFAULT_VCPUS = 2;
const DEFAULT_TIMEOUT_MINUTES = 60;
const API_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const LIVE_TTL_MS = 15_000;
const TRUST_WINDOW_MS = 120_000;
const RECONCILE_CONCURRENCY = 5;
const KEEPALIVE_MARGIN_MS = 10 * 60_000;
const KEEPALIVE_EXTEND_MS = 30 * 60_000;
const BOOT_WAIT_MS = 90_000;
const HEALTH_ATTEMPTS = 20;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const MISSING_FILE_EXIT = 44;
const PROCESS_GROUP_WRAPPER =
  'exec 3<&0; setsid -w "$@" <&3 3<&- & pid=$!; trap \'kill -TERM -$pid 2>/dev/null; kill -TERM $pid 2>/dev/null\' TERM INT HUP; wait $pid; s=$?; if kill -0 $pid 2>/dev/null; then wait $pid; s=$?; fi; exit $s';

export type VercelSandboxStatus =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'snapshotting'
  | 'failed'
  | 'aborted';

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export interface VercelLogLine {
  stream: string;
  data: unknown;
}

export interface VercelCommandLike {
  exitCode: number | null;
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  stdout(opts?: { signal?: AbortSignal }): Promise<string>;
  stderr(opts?: { signal?: AbortSignal }): Promise<string>;
  logs(opts?: { signal?: AbortSignal }): AsyncIterable<VercelLogLine> & { close?(): void };
  kill(signal?: any): Promise<void>;
}

export interface VercelRunCommandParams {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  sudo?: boolean;
  detached?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VercelSessionLike {
  domain(port: number): string;
  runCommand(params: VercelRunCommandParams): Promise<VercelCommandLike>;
  writeFiles(
    files: { path: string; content: Uint8Array; mode?: number }[],
    opts?: { signal?: AbortSignal }
  ): Promise<void>;
  readFileToBuffer(file: { path: string }, opts?: { signal?: AbortSignal }): Promise<Buffer | null>;
  extendTimeout(duration: number, opts?: { signal?: AbortSignal }): Promise<void>;
  openInteractive?(opts?: { signal?: AbortSignal }): Promise<{ url: string; token: string }>;
}

export interface VercelSandboxLike {
  readonly name: string;
  readonly status: string;
  readonly expiresAt?: Date;
  currentSession(): VercelSessionLike;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  delete(opts?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal }): Promise<void>;
  update(params: { networkPolicy?: unknown }, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface VercelSdk {
  create(params: Record<string, unknown> & VercelCredentials): Promise<VercelSandboxLike>;
  get(
    params: { name: string; resume?: boolean; signal?: AbortSignal } & VercelCredentials
  ): Promise<VercelSandboxLike>;
  fork?(
    params: Record<string, unknown> & { sourceSandbox: string } & VercelCredentials
  ): Promise<VercelSandboxLike>;
}

let vercelModule: Promise<typeof VercelSandboxModule> | null = null;

function loadVercelModule(): Promise<typeof VercelSandboxModule> {
  vercelModule ??= import('@vercel/sandbox');
  return vercelModule;
}

const realSdk: VercelSdk = {
  create: async (params) =>
    (await (
      await loadVercelModule()
    ).Sandbox.create(params as never)) as unknown as VercelSandboxLike,
  get: async (params) =>
    (await (await loadVercelModule()).Sandbox.get(params as never)) as unknown as VercelSandboxLike,
  fork: async (params) =>
    (await (await loadVercelModule()).Sandbox.fork(params as never)) as unknown as VercelSandboxLike
};

export async function vercelInteractiveSupported(): Promise<boolean> {
  const { Session } = await loadVercelModule();
  return (
    typeof (Session?.prototype as { openInteractive?: unknown } | undefined)?.openInteractive ===
    'function'
  );
}

interface VercelSettings {
  credentials: VercelCredentials | null;
  missing: string[];
  image: string;
  vcpus: number;
  timeoutMs: number;
  bridgeUrl: string;
  bridgeSha256: string | null;
  bridgeOverridden: boolean;
}

interface LifecycleRow {
  id: string;
  userId: string;
  runner: string;
  podName: string;
  runnerState: unknown;
  status: SandboxStatus;
  desiredState: SandboxDesiredState;
  repoUrl: string | null;
  image: string;
  setupScript: string | null;
}

export interface VercelStatusChange {
  status: SandboxStatus;
  statusMessage?: string | null;
  desiredState?: SandboxDesiredState;
  startedAt?: null;
}

export function vercelStatusChange(
  row: { id: string; status: SandboxStatus; desiredState: SandboxDesiredState },
  observed: { exists: boolean; status: string | null }
): VercelStatusChange | null {
  if (row.status === 'deleting' || row.desiredState === 'deleted') return null;
  if (!observed.exists) {
    return deriveObservedStatus(row, { exists: false, status: null, message: VERCEL_SANDBOX_GONE });
  }
  switch (observed.status) {
    case 'running':
      return deriveObservedStatus(row, { exists: true, status: 'running', message: null });
    case 'stopping':
    case 'snapshotting':
      return row.status === 'running' ? { status: 'stopping' } : null;
    case 'stopped':
      if (row.desiredState === 'stopped') {
        return deriveObservedStatus(row, { exists: true, status: 'stopped', message: null });
      }
      if (row.status === 'running' || row.status === 'stopping') {
        return {
          status: 'stopped',
          desiredState: 'stopped',
          statusMessage: VERCEL_PROVIDER_STOPPED,
          startedAt: null
        };
      }
      return null;
    case 'failed':
    case 'aborted':
      return row.status === 'error'
        ? null
        : { status: 'error', statusMessage: VERCEL_SANDBOX_FAILED };
    default:
      return null;
  }
}

export function vercelPorts(previewPorts: readonly number[] = VERCEL_PREVIEW_PORTS): number[] {
  const allowed = new Set(VERCEL_PREVIEW_PORTS);
  for (const port of previewPorts) {
    if (!allowed.has(port)) throw new Error(`port ${port} is not an allowed preview port`);
  }
  const ports = [...new Set([VERCEL_OPENCODE_PORT, VERCEL_BRIDGE_PORT, ...previewPorts])];
  if (ports.length > VERCEL_MAX_PORTS) {
    throw new Error(`a Vercel sandbox can expose at most ${VERCEL_MAX_PORTS} ports`);
  }
  return ports;
}

export function exposedPort(port: number): boolean {
  return (
    port === VERCEL_OPENCODE_PORT ||
    port === VERCEL_BRIDGE_PORT ||
    VERCEL_PREVIEW_PORTS.includes(port)
  );
}

export const VERCEL_HOST_GIT_PLACEHOLDER = 'orchard-host-git-token';

function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

export function githubNetworkPolicy(token: string | null): unknown {
  if (!token) return 'allow-all';
  return {
    allow: {
      'github.com': [
        {
          match: {
            headers: [
              {
                key: { exact: 'authorization' },
                value: { exact: basicAuth(VERCEL_HOST_GIT_PLACEHOLDER) }
              }
            ]
          },
          transform: [{ headers: { authorization: basicAuth(token) } }]
        }
      ],
      'api.github.com': [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
      '*': []
    }
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function asUser(user: string | undefined, script: string): string[] {
  if (!user) return ['/bin/sh', '-c', script];
  if (!USER_RE.test(user)) throw new Error(`invalid sandbox user ${user}`);
  return ['su', user, '-s', '/bin/sh', '-c', script];
}

function apiStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } } | null)?.response?.status;
}

function apiCode(e: unknown): string | undefined {
  return (e as { json?: { error?: { code?: string } } } | null)?.json?.error?.code;
}

function isNotFound(e: unknown): boolean {
  return apiStatus(e) === 404;
}

function isStopped(e: unknown): boolean {
  const status = apiStatus(e);
  if (status === 410) return true;
  return status === 422 && ['sandbox_stopping', 'sandbox_snapshotting'].includes(apiCode(e) ?? '');
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function statusOf(sandbox: VercelSandboxLike): string {
  try {
    return sandbox.status;
  } catch {
    return 'stopped';
  }
}

function expiresAtOf(sandbox: VercelSandboxLike): Date | null {
  try {
    const value = sandbox.expiresAt;
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
  } catch {
    return null;
  }
}

function sliceContent(content: Buffer, max: number, fromEnd?: boolean): ReadFileResult {
  if (content.length <= max) return { content, truncated: false };
  return {
    content: fromEnd ? content.subarray(content.length - max) : content.subarray(0, max),
    truncated: true
  };
}

function idleWindowMs(): number {
  const minutes = Number(process.env.SANDBOX_IDLE_TIMEOUT_MINUTES);
  const resolved = Number.isFinite(minutes) ? minutes : 60;
  return resolved > 0 ? resolved * 60_000 : 0;
}

function positive(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function interactiveHealthUrl(url: string): string {
  const parsed = new URL(url);
  const protocol =
    parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
  return `${protocol}//${parsed.host}/health`;
}

function bridgeUrl(domain: string): string {
  const parsed = new URL(domain);
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
  parsed.pathname = '/';
  parsed.search = '';
  return parsed.toString();
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface InteractiveDeps {
  fetch?: typeof fetch;
  delayMs?: number;
  openTimeoutMs?: number;
}

export async function openInteractivePty(
  url: string,
  token: string,
  opts: PtyOptions,
  deps: InteractiveDeps = {}
): Promise<PtyHandle> {
  const doFetch = deps.fetch ?? fetch;
  const delay = deps.delayMs ?? 500;
  const health = interactiveHealthUrl(url);
  let healthy = false;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS && !healthy; attempt += 1) {
    try {
      const res = await doFetch(health, { signal: AbortSignal.timeout(3000) });
      healthy = res.ok;
    } catch {}
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!healthy) throw new SandboxNotRunningError('The sandbox shell did not come up in time');

  const target = new URL(url);
  target.searchParams.set('token', token);
  const ws = new WebSocket(target.toString(), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('the sandbox shell did not answer'));
    }, deps.openTimeoutMs ?? 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  const output = new PassThrough();
  let resolveExit!: (value: { ok: boolean; message: string | null }) => void;
  const exited = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  let ended = false;
  const end = (value: { ok: boolean; message: string | null }) => {
    if (ended) return;
    ended = true;
    if (!output.writableEnded) output.end();
    resolveExit(value);
  };
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    const chunk = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (isBinary) {
      output.write(chunk);
      return;
    }
    let frame: { type?: string; code?: unknown } | null = null;
    try {
      frame = JSON.parse(chunk.toString('utf8'));
    } catch {
      return;
    }
    if (frame?.type === 'exit') {
      const code = typeof frame.code === 'number' ? frame.code : null;
      end({ ok: code === 0, message: code === 0 ? null : `shell exited with code ${code}` });
      try {
        ws.close();
      } catch {}
    }
  });
  ws.on('close', () => end({ ok: false, message: 'shell closed' }));
  ws.on('error', () => end({ ok: false, message: 'shell connection failed' }));

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (ws.readyState !== WebSocket.OPEN) {
        callback();
        return;
      }
      ws.send(chunk, { binary: true }, () => callback());
    }
  });

  const script = `exec ${opts.command.map(shellQuote).join(' ')}`;
  ws.send(
    JSON.stringify({
      type: 'start',
      command: 'sudo',
      args: ['-n', '/bin/sh', '-c', script],
      env: ['TERM=xterm-256color'],
      cwd: '/',
      cols: opts.cols,
      rows: opts.rows
    })
  );

  return {
    stdin,
    output,
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    pause: () => ws.pause(),
    resume: () => ws.resume(),
    close: () => {
      try {
        ws.close();
      } catch {}
    },
    exited
  };
}

export async function openBridgeStream(
  url: string,
  token: string,
  timeoutMs = 15_000
): Promise<Duplex> {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
    perMessageDeflate: false
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('the sandbox bridge did not answer'));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`the sandbox bridge refused the tunnel (${res.statusCode})`));
    });
    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return createWebSocketStream(ws);
}

@Injectable()
export class VercelSandboxRunner implements SandboxRunner {
  readonly id = 'vercel' as const;

  readonly label = 'Vercel';

  private readonly logger = new Logger(VercelSandboxRunner.name);

  sdk: VercelSdk = realSdk;

  bridgeChecksums = new BridgeChecksumResolver();

  interactiveSupported = false;

  bootPollMs = 2000;

  private settingsCache: { generation: number; value: VercelSettings } | null = null;

  private instanceIdCache: string | null = null;

  private lastApiOkAt = 0;

  private readonly live = new Map<string, { sandbox: VercelSandboxLike; at: number }>();

  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InstanceConfigService,
    private readonly instanceSettings: InstanceSettingsService,
    private readonly queue: ApplyQueueService,
    private readonly executor: ApplyExecutorService,
    private readonly secrets: SandboxSecretsService
  ) {
    for (const op of [VERCEL_OP_PROVISION, VERCEL_OP_START, VERCEL_OP_STOP, VERCEL_OP_FORK]) {
      this.executor.registerHandler(op, (item) =>
        this.serialized(item, () => this.applyLifecycle(item))
      );
    }
    this.executor.registerHandler(VERCEL_OP_SECRET, (item) =>
      this.serialized(item, () => this.applySecret(item))
    );
    this.executor.registerHandler(VERCEL_OP_DESTROY, (item) =>
      this.serialized(item, () => this.applyDestroy(item))
    );
    vercelInteractiveSupported().then(
      (supported) => {
        this.interactiveSupported = supported;
      },
      (e: any) => this.logger.warn(`could not load @vercel/sandbox: ${e?.message}`)
    );
  }

  get capabilities(): SandboxRunnerCapabilities {
    return {
      statusSource: 'poll',
      persistence: 'snapshot',
      homeMode: 'none',
      tcpTunnel: 'bridge',
      pty: this.interactiveSupported ? 'native' : 'none',
      execStdin: true,
      maxRunMs: null,
      diskSizeConfigurable: false,
      fork: true,
      previews: 'public'
    };
  }

  private settings(): VercelSettings {
    const generation = this.config.generation;
    if (this.settingsCache && this.settingsCache.generation === generation) {
      return this.settingsCache.value;
    }
    const read = (name: string) => this.config.value(SANDBOX_RUNNERS, name)?.trim() || null;
    const token = read('vercelToken');
    const teamId = read('vercelTeamId');
    const projectId = read('vercelProjectId');
    const missing: string[] = [];
    if (!token) missing.push('vercelToken (SANDBOX_VERCEL_TOKEN)');
    if (!teamId) missing.push('vercelTeamId (SANDBOX_VERCEL_TEAM_ID)');
    if (!projectId) missing.push('vercelProjectId (SANDBOX_VERCEL_PROJECT_ID)');
    const value: VercelSettings = {
      credentials: token && teamId && projectId ? { token, teamId, projectId } : null,
      missing,
      image: read('vercelImage') || VERCEL_DEFAULT_IMAGE,
      vcpus: Math.floor(positive(read('vercelVcpus'), DEFAULT_VCPUS)),
      timeoutMs: positive(read('vercelTimeoutMinutes'), DEFAULT_TIMEOUT_MINUTES) * 60_000,
      bridgeUrl: read('bridgeBinaryUrl') || defaultBridgeBinaryUrl(),
      bridgeSha256: read('bridgeBinarySha256')?.toLowerCase() || null,
      bridgeOverridden: !!read('bridgeBinaryUrl')
    };
    this.settingsCache = { generation, value };
    return value;
  }

  configError(): string | null {
    const { missing, bridgeOverridden, bridgeSha256 } = this.settings();
    if (missing.length) return `Vercel sandboxes need ${missing.join(', ')}`;
    if (bridgeOverridden && !bridgeSha256) {
      return 'Vercel sandboxes need bridgeBinarySha256 (SANDBOX_BRIDGE_BINARY_SHA256) when bridgeBinaryUrl is set, so machines can verify the bridge they download';
    }
    if (!deriveSandboxSecret('opencode-password', 'probe')) {
      return 'Vercel sandboxes need SECRETS_ENCRYPTION_KEY so their public ports are password protected';
    }
    return null;
  }

  defaultImage(): string {
    return this.settings().image;
  }

  private credentials(): VercelCredentials {
    const error = this.configError();
    const credentials = this.settings().credentials;
    if (error || !credentials) throw new Error(error ?? 'Vercel is not configured');
    return credentials;
  }

  private liveCredentials(): VercelCredentials {
    try {
      return this.credentials();
    } catch (e: any) {
      throw new SandboxNotRunningError(e?.message);
    }
  }

  private markApiOk(): void {
    this.lastApiOkAt = Date.now();
  }

  private async instanceId(): Promise<string> {
    if (this.instanceIdCache) return this.instanceIdCache;
    const existing = await this.instanceSettings.get(INSTANCE_SETTING_KEY);
    if (existing) {
      this.instanceIdCache = existing;
      return existing;
    }
    await this.instanceSettings.createIfAbsent(INSTANCE_SETTING_KEY, randomUUID());
    const value = await this.instanceSettings.get(INSTANCE_SETTING_KEY);
    if (!value) throw new Error('could not resolve the sandbox instance id');
    this.instanceIdCache = value;
    return value;
  }

  private async serialized(item: ApplyItemInput, fn: () => Promise<void>): Promise<void> {
    const key = this.sandboxIdOf(item) ?? item.dedupeKey;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private sandboxIdOf(item: ApplyItemInput): string | null {
    const manifest = (item.manifest ?? {}) as { sandboxId?: unknown };
    return typeof manifest.sandboxId === 'string' ? manifest.sandboxId : null;
  }

  private async enqueue(
    ref: SandboxRef,
    dedupeKey: string,
    opType: string,
    requestedById?: string | null
  ): Promise<void> {
    await this.queue.enqueue({
      dedupeKey,
      opType,
      manifest: { sandboxId: ref.id },
      sandboxId: ref.id,
      requestedById: requestedById ?? undefined
    });
  }

  async requestProvision(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.enqueue(ref, vercelLifecycleKey(ref.id), VERCEL_OP_PROVISION, requestedById);
  }

  async requestStart(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.enqueue(ref, vercelLifecycleKey(ref.id), VERCEL_OP_START, requestedById);
  }

  async requestStop(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    this.live.delete(ref.id);
    await this.enqueue(ref, vercelLifecycleKey(ref.id), VERCEL_OP_STOP, requestedById);
  }

  async requestDestroy(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    this.live.delete(ref.id);
    await this.enqueue(ref, vercelDestroyKey(ref.id), VERCEL_OP_DESTROY, requestedById);
  }

  async requestSecretSync(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.enqueue(ref, vercelSecretKey(ref.id), VERCEL_OP_SECRET, requestedById);
  }

  async forkSupport(): Promise<string | null> {
    return this.configError();
  }

  async requestFork(
    source: SandboxRef,
    target: SandboxRef,
    requestedById?: string | null
  ): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: vercelLifecycleKey(target.id),
      opType: VERCEL_OP_FORK,
      manifest: { sandboxId: target.id, sourceSandboxId: source.id },
      sandboxId: target.id,
      requestedById: requestedById ?? undefined
    });
  }

  private async find(
    name: string,
    credentials: VercelCredentials
  ): Promise<VercelSandboxLike | null> {
    try {
      const sandbox = await this.sdk.get({
        name,
        ...credentials,
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      this.markApiOk();
      return sandbox;
    } catch (e) {
      if (isNotFound(e)) {
        this.markApiOk();
        return null;
      }
      throw e;
    }
  }

  private async loadLifecycleRow(sandboxId: string): Promise<LifecycleRow | null> {
    return this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: {
        ...SANDBOX_REF_SELECT,
        status: true,
        desiredState: true,
        repoUrl: true,
        image: true,
        setupScript: true
      }
    });
  }

  private async mergeRunnerState(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.prisma.sandbox.findUnique({
      where: { id },
      select: { runnerState: true }
    });
    if (!row) return;
    const state =
      row.runnerState && typeof row.runnerState === 'object' && !Array.isArray(row.runnerState)
        ? (row.runnerState as Record<string, unknown>)
        : {};
    await this.prisma.sandbox.updateMany({
      where: { id },
      data: { runnerState: { ...state, ...patch } as object }
    });
  }

  private async applyLifecycle(item: ApplyItemInput): Promise<void> {
    const sandboxId = this.sandboxIdOf(item);
    if (!sandboxId) return;
    const row = await this.loadLifecycleRow(sandboxId);
    if (!row || row.runner !== 'vercel' || row.desiredState === 'deleted') return;
    const credentials = this.credentials();
    if (row.desiredState === 'stopped') {
      await this.convergeStopped(row, credentials);
      return;
    }
    await this.convergeRunning(row, credentials);
  }

  private async convergeStopped(row: LifecycleRow, credentials: VercelCredentials): Promise<void> {
    this.live.delete(row.id);
    const sandbox = await this.find(row.podName, credentials);
    let settled = true;
    if (sandbox) {
      const status = statusOf(sandbox);
      if (status === 'running' || status === 'pending') {
        const result = (await sandbox.stop({ signal: AbortSignal.timeout(API_TIMEOUT_MS) })) as {
          status?: string;
        } | null;
        settled = result?.status === 'stopped';
      } else {
        settled = status !== 'stopping' && status !== 'snapshotting';
      }
    }
    if (!settled) return;
    await this.prisma.sandbox.updateMany({
      where: { id: row.id, desiredState: 'stopped', status: { in: ['stopping', 'running'] } },
      data: { status: 'stopped' }
    });
  }

  private async convergeRunning(row: LifecycleRow, credentials: VercelCredentials): Promise<void> {
    const secrets = await this.secrets.forSandbox(row);
    if (!secrets.opencodePassword || !secrets.bridgeToken) {
      throw new Error('SECRETS_ENCRYPTION_KEY is required to start a Vercel sandbox');
    }
    const policy = githubNetworkPolicy(secrets.githubToken);
    let sandbox: VercelSandboxLike;
    try {
      sandbox = await this.sdk.get({
        name: row.podName,
        resume: true,
        ...credentials,
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
      });
      this.markApiOk();
      await sandbox.update(
        { networkPolicy: policy },
        { signal: AbortSignal.timeout(API_TIMEOUT_MS) }
      );
    } catch (e) {
      if (!isNotFound(e)) throw e;
      this.markApiOk();
      sandbox = await this.createOrFork(row, credentials, policy);
    }
    sandbox = await this.waitRunning(sandbox, row.podName, credentials);
    this.live.set(row.id, { sandbox, at: Date.now() });
    await this.pushInit(sandbox.currentSession(), row, secrets);
    const expiresAt = expiresAtOf(sandbox);
    await this.mergeRunnerState(row.id, {
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      bridgeUrl: this.settings().bridgeUrl
    });
    await this.prisma.sandbox.updateMany({
      where: { id: row.id, desiredState: 'running', status: { in: ['creating', 'starting'] } },
      data: { status: 'running', statusMessage: null, externalId: row.podName }
    });
  }

  private async createOrFork(
    row: LifecycleRow,
    credentials: VercelCredentials,
    networkPolicy: unknown
  ): Promise<VercelSandboxLike> {
    const fork = forkSourceOf(row.runnerState);
    const state =
      row.runnerState && typeof row.runnerState === 'object'
        ? (row.runnerState as Record<string, unknown>)
        : {};
    if (!fork || state.forkedAt) return this.create(row, credentials, networkPolicy);
    if (!this.sdk.fork) throw new Error('This @vercel/sandbox version cannot fork sandboxes');
    const settings = this.settings();
    let sandbox: VercelSandboxLike;
    try {
      sandbox = await this.sdk.fork({
        sourceSandbox: fork.podName,
        name: row.podName,
        timeout: settings.timeoutMs,
        ports: vercelPorts(),
        persistent: true,
        tags: {
          orchard_instance: await this.instanceId(),
          orchard_sandbox: row.id,
          orchard_user: row.userId,
          orchard_fork_of: fork.sandboxId
        },
        networkPolicy,
        ...credentials,
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
      });
    } catch (e) {
      if (isNotFound(e)) throw new Error('The machine being forked no longer exists on Vercel');
      throw e;
    }
    this.markApiOk();
    await this.mergeRunnerState(row.id, { forkedAt: new Date().toISOString() });
    return sandbox;
  }

  private async create(
    row: LifecycleRow,
    credentials: VercelCredentials,
    networkPolicy: unknown
  ): Promise<VercelSandboxLike> {
    const settings = this.settings();
    const sandbox = await this.sdk.create({
      name: row.podName,
      image: row.image || settings.image,
      resources: { vcpus: settings.vcpus },
      timeout: settings.timeoutMs,
      ports: vercelPorts(),
      persistent: true,
      tags: {
        orchard_instance: await this.instanceId(),
        orchard_sandbox: row.id,
        orchard_user: row.userId
      },
      networkPolicy,
      ...credentials,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
    });
    this.markApiOk();
    return sandbox;
  }

  private async waitRunning(
    sandbox: VercelSandboxLike,
    name: string,
    credentials: VercelCredentials
  ): Promise<VercelSandboxLike> {
    const deadline = Date.now() + BOOT_WAIT_MS;
    let current = sandbox;
    for (;;) {
      const status = statusOf(current);
      if (status === 'running') return current;
      if (status === 'failed' || status === 'aborted') throw new Error(VERCEL_SANDBOX_FAILED);
      if (Date.now() > deadline) throw new Error(`the Vercel sandbox is still ${status}`);
      await new Promise((resolve) => setTimeout(resolve, this.bootPollMs));
      const next = await this.find(name, credentials);
      if (!next) throw new Error(VERCEL_SANDBOX_GONE);
      current = next;
    }
  }

  async bridgeSha256(): Promise<string | null> {
    const { bridgeUrl, bridgeSha256 } = this.settings();
    const sha = await this.bridgeChecksums.resolve(bridgeUrl, bridgeSha256);
    if (!sha)
      this.logger.warn(
        `no checksum for the sandbox bridge at ${bridgeUrl}; machines will not install it`
      );
    return sha;
  }

  async bridgeArm64(): Promise<{ url: string; sha: string } | null> {
    const { bridgeUrl } = this.settings();
    if (bridgeUrl !== defaultBridgeBinaryUrl()) return null;
    const url = defaultBridgeBinaryUrl(undefined, 'arm64');
    const sha = await this.bridgeChecksums.resolve(url, null, 'arm64');
    return sha ? { url, sha } : null;
  }

  bootstrapEnv(
    row: { repoUrl: string | null },
    secrets: SandboxSecrets,
    bridgeSha256: string | null = null,
    arm64: { url: string; sha: string } | null = null
  ): Record<string, string> {
    return {
      ORCHARD_INIT_STAGE: VERCEL_INIT_STAGE,
      SANDBOX_HOME_MODE: 'none',
      SANDBOX_PERSIST_ROOT: VERCEL_PERSIST_ROOT,
      SANDBOX_REPO_URL: row.repoUrl || '',
      CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeToken || '',
      OPENAI_API_KEY: secrets.openaiToken || '',
      GIT_TOKEN: secrets.githubToken ? VERCEL_HOST_GIT_PLACEHOLDER : '',
      ORCHARD_BRIDGE_URL: this.settings().bridgeUrl,
      ...(bridgeSha256 ? { ORCHARD_BRIDGE_SHA256: bridgeSha256 } : {}),
      ...(arm64
        ? { ORCHARD_BRIDGE_URL_ARM64: arm64.url, ORCHARD_BRIDGE_SHA256_ARM64: arm64.sha }
        : {})
    };
  }

  private async pushInit(
    session: VercelSessionLike,
    row: { repoUrl: string | null },
    secrets: SandboxSecrets
  ): Promise<void> {
    const files = stagedInitFiles(secrets, { requireHttpsMcp: true });
    await session.writeFiles(
      [
        ...Object.entries(files).map(([name, content]) => ({
          path: `${VERCEL_INIT_STAGE}/${name}`,
          content: Buffer.from(content, 'utf8'),
          mode: SECRET_INIT_FILES.includes(name) ? 0o600 : 0o644
        })),
        { path: SANDBOX_PHASE_FILE, content: Buffer.from('starting'), mode: 0o644 }
      ],
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) }
    );
    await session.runCommand({
      cmd: 'bash',
      args: [`${VERCEL_INIT_STAGE}/bootstrap.sh`],
      env: this.bootstrapEnv(row, secrets, await this.bridgeSha256(), await this.bridgeArm64()),
      sudo: true,
      detached: true,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  }

  private async applySecret(item: ApplyItemInput): Promise<void> {
    const sandboxId = this.sandboxIdOf(item);
    if (!sandboxId) return;
    const row = await this.loadLifecycleRow(sandboxId);
    if (!row || row.runner !== 'vercel' || row.desiredState === 'deleted') return;
    const credentials = this.credentials();
    const sandbox = await this.find(row.podName, credentials);
    if (!sandbox) return;
    const secrets = await this.secrets.forSandbox(row);
    await sandbox.update(
      { networkPolicy: githubNetworkPolicy(secrets.githubToken) },
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) }
    );
    if (row.desiredState !== 'running' || statusOf(sandbox) !== 'running') return;
    try {
      await this.pushInit(sandbox.currentSession(), row, secrets);
    } catch (e) {
      if (isStopped(e)) return;
      throw e;
    }
  }

  private async applyDestroy(item: ApplyItemInput): Promise<void> {
    const sandboxId = this.sandboxIdOf(item);
    if (!sandboxId) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { id: true, podName: true, desiredState: true, runner: true }
    });
    if (row && (row.desiredState !== 'deleted' || row.runner !== 'vercel')) {
      this.logger.warn(`refusing to destroy sandbox ${row.id}: it is not marked for deletion`);
      return;
    }
    const credentials = this.credentials();
    const sandbox = await this.find(row?.podName ?? `sbx-${sandboxId}`, credentials);
    if (sandbox) {
      await sandbox.delete({
        deleteOrphanSnapshots: true,
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
    }
    this.live.delete(sandboxId);
    if (row) {
      await this.prisma.sandbox.deleteMany({ where: { id: row.id, desiredState: 'deleted' } });
    }
  }

  async observe(ref: SandboxRef): Promise<RunnerObservation> {
    const sandbox = await this.find(ref.podName, this.credentials());
    if (!sandbox) return { exists: false, status: null, message: null };
    const status = statusOf(sandbox);
    return {
      exists: true,
      status: status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : null,
      message: status === 'failed' || status === 'aborted' ? VERCEL_SANDBOX_FAILED : null
    };
  }

  async canTrustAbsence(): Promise<boolean> {
    return Date.now() - this.lastApiOkAt < TRUST_WINDOW_MS;
  }

  async reconcile(refs: SandboxRef[]): Promise<void> {
    if (refs.length === 0 || this.configError()) return;
    const credentials = this.credentials();
    const rows = await this.prisma.sandbox.findMany({
      where: { id: { in: refs.map((ref) => ref.id) }, runner: 'vercel' },
      select: { id: true, podName: true, status: true, desiredState: true }
    });
    await mapLimit(rows, RECONCILE_CONCURRENCY, async (row) => {
      let sandbox: VercelSandboxLike | null;
      try {
        sandbox = await this.find(row.podName, credentials);
      } catch (e: any) {
        this.logger.warn(`could not poll vercel sandbox ${row.id}: ${e?.message}`);
        return;
      }
      const status = sandbox ? statusOf(sandbox) : null;
      const change = vercelStatusChange(row, { exists: !!sandbox, status });
      if (change) {
        await this.prisma.sandbox.updateMany({
          where: { id: row.id, status: row.status, desiredState: row.desiredState },
          data: change
        });
        if (change.status !== 'running') this.live.delete(row.id);
      }
      const expiresAt = sandbox && status === 'running' ? expiresAtOf(sandbox) : null;
      if (expiresAt) await this.mergeRunnerState(row.id, { expiresAt: expiresAt.toISOString() });
    });
  }

  async keepAlive(ref: SandboxRef): Promise<void> {
    if (this.configError()) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { id: ref.id },
      select: {
        status: true,
        desiredState: true,
        lastActiveAt: true,
        runnerState: true,
        podName: true
      }
    });
    if (!row || row.status !== 'running' || row.desiredState !== 'running') return;
    const idle = idleWindowMs();
    const lastActive = row.lastActiveAt?.getTime() ?? 0;
    if (idle && Date.now() - lastActive > idle) return;
    const state = (row.runnerState ?? {}) as { expiresAt?: unknown };
    const expiresAt = typeof state.expiresAt === 'string' ? Date.parse(state.expiresAt) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > KEEPALIVE_MARGIN_MS) return;
    const sandbox = await this.find(row.podName, this.credentials());
    if (!sandbox || statusOf(sandbox) !== 'running') return;
    await sandbox
      .currentSession()
      .extendTimeout(KEEPALIVE_EXTEND_MS, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const base = expiresAtOf(sandbox)?.getTime() ?? Date.now();
    await this.mergeRunnerState(ref.id, {
      expiresAt: new Date(base + KEEPALIVE_EXTEND_MS).toISOString()
    });
  }

  private async running(ref: SandboxRef): Promise<VercelSessionLike> {
    const cached = this.live.get(ref.id);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.sandbox.currentSession();
    const credentials = this.liveCredentials();
    const sandbox = await this.find(ref.podName, credentials);
    if (!sandbox) throw new SandboxNotRunningError('Sandbox does not exist');
    if (statusOf(sandbox) !== 'running') {
      this.live.delete(ref.id);
      throw new SandboxNotRunningError();
    }
    this.live.set(ref.id, { sandbox, at: Date.now() });
    return sandbox.currentSession();
  }

  private async withSession<T>(
    ref: SandboxRef,
    fn: (session: VercelSessionLike) => Promise<T>
  ): Promise<T> {
    const session = await this.running(ref);
    try {
      return await fn(session);
    } catch (e) {
      if (isStopped(e)) {
        this.live.delete(ref.id);
        throw new SandboxNotRunningError();
      }
      throw e;
    }
  }

  private async withStdin(
    session: VercelSessionLike,
    command: string[],
    stdin: Buffer | undefined
  ): Promise<{ cmd: string; args: string[] }> {
    if (command.length === 0) throw new Error('empty sandbox command');
    if (!stdin) return { cmd: command[0], args: command.slice(1) };
    const path = `/tmp/orchard-stdin-${randomUUID()}`;
    await session.writeFiles([{ path, content: stdin, mode: 0o600 }], {
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    return {
      cmd: '/bin/sh',
      args: [
        '-c',
        'f=$1; shift; exec < "$f" || exit 1; rm -f "$f"; exec "$@"',
        'sh',
        path,
        ...command
      ]
    };
  }

  private checkEnv(env: Record<string, string> | undefined): void {
    for (const key of Object.keys(env ?? {})) {
      if (!ENV_NAME_RE.test(key)) throw new Error(`invalid environment variable name ${key}`);
    }
  }

  async exec(ref: SandboxRef, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.checkEnv(opts.env);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    return this.withSession(ref, async (session) => {
      const { cmd, args } = await this.withStdin(session, command, opts.stdin);
      const signal = AbortSignal.timeout(timeoutMs + 5000);
      try {
        const finished = await session.runCommand({
          cmd,
          args,
          env: opts.env,
          sudo: true,
          signal,
          timeoutMs
        });
        const [stdout, stderr] = await Promise.all([
          finished.stdout({ signal }),
          finished.stderr({ signal })
        ]);
        const exitCode = finished.exitCode;
        return { stdout, stderr, exitCode, ok: exitCode === 0 };
      } catch (e) {
        if (isTimeout(e)) throw new Error('sandbox command timed out');
        throw e;
      }
    });
  }

  async execStream(
    ref: SandboxRef,
    command: string[],
    opts: ExecOptions = {}
  ): Promise<ExecStream> {
    this.checkEnv(opts.env);
    return this.withSession(ref, async (session) => {
      const { cmd, args } = await this.withStdin(session, command, opts.stdin);
      const running = await session.runCommand({
        cmd: '/bin/sh',
        args: ['-c', PROCESS_GROUP_WRAPPER, 'sh', cmd, ...args],
        env: opts.env,
        sudo: true,
        detached: true,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let resolveDone!: (value: {
        ok: boolean;
        exitCode: number | null;
        message: string | null;
      }) => void;
      const done = new Promise<{ ok: boolean; exitCode: number | null; message: string | null }>(
        (resolve) => {
          resolveDone = resolve;
        }
      );
      let finished = false;
      let killed = false;
      const finish = (value: { ok: boolean; exitCode: number | null; message: string | null }) => {
        if (finished) return;
        finished = true;
        if (!stdout.writableEnded) stdout.end();
        if (!stderr.writableEnded) stderr.end();
        resolveDone(value);
      };
      const logs = running.logs();
      const kill = () => {
        killed = true;
        try {
          logs.close?.();
        } catch {}
        void running.kill().catch(() => {});
      };
      void (async () => {
        let failure: string | null = null;
        try {
          for await (const line of logs) {
            const data = typeof line.data === 'string' ? line.data : '';
            if (line.stream === 'stdout') stdout.write(data);
            else if (line.stream === 'stderr') stderr.write(data);
          }
        } catch (e: any) {
          if (!killed) failure = e?.message ?? 'lost the sandbox command output';
        }
        let exitCode: number | null = null;
        if (!killed) {
          try {
            exitCode = (await running.wait()).exitCode;
          } catch (e: any) {
            failure = failure ?? e?.message ?? 'lost the sandbox command';
          }
        }
        finish({
          ok: exitCode === 0,
          exitCode,
          message: killed ? 'killed' : exitCode === 0 ? null : failure
        });
      })();
      if (opts.timeoutMs) {
        const timer = setTimeout(() => {
          kill();
          finish({ ok: false, exitCode: null, message: 'sandbox command timed out' });
        }, opts.timeoutMs);
        void done.then(() => clearTimeout(timer));
      }
      return { stdout, stderr, done, kill };
    });
  }

  async writeFiles(
    ref: SandboxRef,
    files: SandboxFileWrite[],
    opts: WriteFilesOptions = {}
  ): Promise<void> {
    if (files.length === 0) return;
    for (const file of files) {
      if (!file.path.startsWith('/') || file.path.includes('\0')) {
        throw new Error('sandbox file paths must be absolute');
      }
    }
    if (opts.asUser && !USER_RE.test(opts.asUser)) {
      throw new Error(`invalid sandbox user ${opts.asUser}`);
    }
    const timeoutMs = opts.timeoutMs ?? 30_000;
    await this.withSession(ref, async (session) => {
      const stage = `/tmp/orchard-write-${randomUUID()}`;
      await session.writeFiles(
        files.map((file, i) => ({ path: `${stage}/${i}`, content: file.content, mode: 0o600 })),
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      const steps = files.map((file, i) => {
        const dest = shellQuote(file.path);
        const src = shellQuote(`${stage}/${i}`);
        const write = `mkdir -p "$(dirname ${dest})" && cat > ${dest}`;
        const step = opts.asUser
          ? `su ${opts.asUser} -s /bin/sh -c ${shellQuote(write)} < ${src}`
          : `(${write}) < ${src}`;
        return `${step} || exit 1`;
      });
      const script = `trap 'rm -rf ${shellQuote(stage)}' EXIT; ${steps.join('; ')}`;
      const signal = AbortSignal.timeout(timeoutMs + 5000);
      const result = await session.runCommand({
        cmd: '/bin/sh',
        args: ['-c', script],
        sudo: true,
        signal,
        timeoutMs
      });
      if (result.exitCode !== 0) {
        const detail = (await result.stderr({ signal }).catch(() => '')).trim().slice(-300);
        throw new Error(
          `could not write ${files.map((f) => f.path).join(', ')}${detail ? `: ${detail}` : ''}`
        );
      }
    });
  }

  async readFile(
    ref: SandboxRef,
    path: string,
    opts: ReadFileOptions
  ): Promise<ReadFileResult | null> {
    if (!path.startsWith('/') || path.includes('\0')) {
      throw new Error('sandbox file paths must be absolute');
    }
    const max = Math.max(0, Math.floor(opts.maxBytes));
    if (!opts.asUser) {
      try {
        const content = await this.withSession(ref, (session) =>
          session.readFileToBuffer({ path }, { signal: AbortSignal.timeout(30_000) })
        );
        if (!content) return null;
        return sliceContent(content, max, opts.fromEnd);
      } catch (e) {
        if (e instanceof SandboxNotRunningError) throw e;
      }
    }
    const quoted = shellQuote(path);
    const read = opts.fromEnd
      ? `tail -c ${max + 1} -- ${quoted}`
      : `head -c ${max + 1} -- ${quoted}`;
    const result = await this.exec(
      ref,
      asUser(
        opts.asUser,
        `[ -f ${quoted} ] || exit ${MISSING_FILE_EXIT}; ${read} | base64 | tr -d '\\n'`
      ),
      { timeoutMs: 30_000 }
    );
    if (!result.ok) return null;
    return sliceContent(Buffer.from(result.stdout.trim(), 'base64'), max, opts.fromEnd);
  }

  async openPty(ref: SandboxRef, opts: PtyOptions): Promise<PtyHandle> {
    const session = await this.running(ref);
    if (!this.interactiveSupported || typeof session.openInteractive !== 'function') {
      throw new SandboxNotRunningError('Interactive shells are not available for Vercel sandboxes');
    }
    let ticket: { url: string; token: string };
    try {
      ticket = await session.openInteractive({ signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch (e) {
      if (isStopped(e)) {
        this.live.delete(ref.id);
        throw new SandboxNotRunningError();
      }
      throw e;
    }
    return openInteractivePty(ticket.url, ticket.token, opts);
  }

  async httpTarget(ref: SandboxRef, port: number): Promise<HttpTarget> {
    if (!exposedPort(port)) {
      throw new SandboxNotRunningError(`Port ${port} is not exposed by Vercel sandboxes`);
    }
    const headers: Record<string, string> = {};
    if (port === VERCEL_OPENCODE_PORT) {
      const password = await this.secrets.boxSecret('opencode-password', ref.id);
      if (!password) throw new SandboxNotRunningError('SECRETS_ENCRYPTION_KEY is not configured');
      headers.authorization = opencodeBasicAuth(password);
    }
    const session = await this.running(ref);
    let baseUrl: string;
    try {
      baseUrl = session.domain(port);
    } catch {
      throw new SandboxNotRunningError(`Port ${port} is not exposed by this sandbox`);
    }
    return { kind: 'url', baseUrl, headers };
  }

  async openTcp(ref: SandboxRef, port: number): Promise<Duplex> {
    if (port !== 22) throw new SandboxNotRunningError(`Port ${port} is not tunnelled`);
    const token = await this.secrets.boxSecret('bridge-token', ref.id);
    if (!token) throw new SandboxNotRunningError('SECRETS_ENCRYPTION_KEY is not configured');
    const session = await this.running(ref);
    let domain: string;
    try {
      domain = session.domain(VERCEL_BRIDGE_PORT);
    } catch {
      throw new SandboxNotRunningError('The sandbox bridge port is not exposed');
    }
    return openBridgeStream(bridgeUrl(domain), token);
  }
}
