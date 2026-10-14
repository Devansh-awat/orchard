import { BadRequestException } from '@nestjs/common';
import type { Duplex, Readable } from 'stream';
import type { SandboxRunnerKind } from '../../generated/prisma/client';
import type { PtyHandle } from '../../core/pty';

export type SandboxRunnerId = SandboxRunnerKind;

export const SANDBOX_RUNNER_IDS: readonly SandboxRunnerId[] = ['kubernetes', 'vercel'];

export function isSandboxRunnerId(value: unknown): value is SandboxRunnerId {
  return typeof value === 'string' && (SANDBOX_RUNNER_IDS as readonly string[]).includes(value);
}

export interface SandboxRunnerCapabilities {
  statusSource: 'watch' | 'poll';
  persistence: 'volume' | 'snapshot';
  homeMode: 'block' | 'filesystem' | 'none';
  tcpTunnel: 'native' | 'bridge' | 'none';
  pty: 'native' | 'none';
  execStdin: boolean;
  maxRunMs: number | null;
  diskSizeConfigurable: boolean;
  fork: boolean;
  previews: 'proxy' | 'public' | 'none';
}

export interface SandboxRef {
  id: string;
  userId: string;
  runner: SandboxRunnerId;
  podName: string;
  namespace: string | null;
  externalId: string | null;
  runnerState: unknown;
}

export interface SandboxSpec extends SandboxRef {
  repoUrl: string | null;
  image: string;
  cpuLimit: string;
  memoryLimit: string;
  diskSize: string;
  setupScript: string | null;
}

export interface SandboxSecrets {
  authorizedKeys: string[];
  githubToken: string | null;
  claudeToken: string | null;
  openaiToken: string | null;
  aiGatewayToken?: string | null;
  setupScript: string | null;
  mcpToken: string | null;
  opencodePassword: string | null;
  bridgeToken: string | null;
  agentdToken?: string | null;
  attachedEnv?: Record<string, string>;
  gitIdentity?: { name: string; email: string } | null;
}

export interface RunnerObservation {
  exists: boolean;
  status: 'running' | 'stopped' | null;
  message: string | null;
}

export interface ExecOptions {
  timeoutMs?: number;
  stdin?: Buffer;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  ok: boolean;
}

export interface ExecStream {
  stdout: Readable;
  stderr: Readable;
  done: Promise<{ ok: boolean; exitCode: number | null; message: string | null }>;
  kill(): void;
}

export interface PtyOptions {
  command: string[];
  cols: number;
  rows: number;
}

export type { PtyHandle };

export type HttpTarget =
  | { kind: 'url'; baseUrl: string; headers: Record<string, string> }
  | { kind: 'exec' };

export interface SandboxFileWrite {
  path: string;
  content: Buffer;
}

export interface WriteFilesOptions {
  asUser?: string;
  timeoutMs?: number;
}

export interface ReadFileOptions {
  maxBytes: number;
  fromEnd?: boolean;
  asUser?: string;
}

export interface ReadFileResult {
  content: Buffer;
  truncated: boolean;
}

export interface SandboxRunner {
  readonly id: SandboxRunnerId;
  readonly label: string;
  readonly capabilities: SandboxRunnerCapabilities;
  readonly namespace?: string;
  configError(): string | null;
  defaultImage?(): string;

  requestProvision(ref: SandboxRef, requestedById?: string | null): Promise<void>;
  requestStart(ref: SandboxRef, requestedById?: string | null): Promise<void>;
  requestStop(ref: SandboxRef, requestedById?: string | null): Promise<void>;
  requestDestroy(ref: SandboxRef, requestedById?: string | null): Promise<void>;
  requestSecretSync(ref: SandboxRef, requestedById?: string | null): Promise<void>;

  observe(ref: SandboxRef): Promise<RunnerObservation>;
  observeDisks?(refs: SandboxRef[]): Promise<Map<string, string>>;
  canTrustAbsence(): Promise<boolean>;
  reconcile?(refs: SandboxRef[]): Promise<void>;
  keepAlive?(ref: SandboxRef): Promise<void>;

  exec(ref: SandboxRef, command: string[], opts?: ExecOptions): Promise<ExecResult>;
  execStream(ref: SandboxRef, command: string[], opts?: ExecOptions): Promise<ExecStream>;
  writeFiles(ref: SandboxRef, files: SandboxFileWrite[], opts?: WriteFilesOptions): Promise<void>;
  readFile(ref: SandboxRef, path: string, opts: ReadFileOptions): Promise<ReadFileResult | null>;

  openPty(ref: SandboxRef, opts: PtyOptions): Promise<PtyHandle>;
  httpTarget(ref: SandboxRef, port: number): Promise<HttpTarget>;
  openTcp(ref: SandboxRef, port: number): Promise<Duplex>;

  requestPreviewPorts?(ref: SandboxRef, ports: number[]): Promise<void>;

  forkSupport?(source: SandboxRef): Promise<string | null>;
  requestFork?(
    source: SandboxRef,
    target: SandboxRef,
    requestedById?: string | null
  ): Promise<void>;
}

export interface SandboxForkSource {
  sandboxId: string;
  podName: string;
}

function stateRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

export function forkSourceOf(state: unknown): SandboxForkSource | null {
  const fork = stateRecord(stateRecord(state).forkFrom);
  return typeof fork.sandboxId === 'string' && typeof fork.podName === 'string'
    ? { sandboxId: fork.sandboxId, podName: fork.podName }
    : null;
}

export class SandboxNotRunningError extends BadRequestException {
  constructor(message = 'Sandbox is not running') {
    super(message);
  }
}

export interface SandboxRowLike {
  id: string;
  userId: string;
  runner: SandboxRunnerKind;
  podName: string;
  namespace: string | null;
  externalId: string | null;
  runnerState: unknown;
}

export function refOf(row: SandboxRowLike): SandboxRef {
  return {
    id: row.id,
    userId: row.userId,
    runner: row.runner,
    podName: row.podName,
    namespace: row.namespace,
    externalId: row.externalId,
    runnerState: row.runnerState ?? null
  };
}

export function specOf(
  row: SandboxRowLike & {
    repoUrl: string | null;
    image: string;
    cpuLimit: string;
    memoryLimit: string;
    diskSize: string;
    setupScript: string | null;
  }
): SandboxSpec {
  return {
    ...refOf(row),
    repoUrl: row.repoUrl,
    image: row.image,
    cpuLimit: row.cpuLimit,
    memoryLimit: row.memoryLimit,
    diskSize: row.diskSize,
    setupScript: row.setupScript
  };
}

export const SANDBOX_REF_SELECT = {
  id: true,
  userId: true,
  runner: true,
  podName: true,
  namespace: true,
  externalId: true,
  runnerState: true
} as const;
