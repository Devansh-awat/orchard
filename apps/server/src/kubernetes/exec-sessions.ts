import { createHmac, timingSafeEqual } from 'crypto';
import { hostname } from 'os';
import Redis from 'ioredis';
import type WebSocket from 'ws';
import { PassThrough, type Writable } from 'stream';
import type { SessionScreen } from './exec-screen';
import type { Proto } from './exec-protocol';
import type { PtyHandle } from './pty';

export const DETACH_GRACE_MS = Number(process.env.EXEC_DETACH_GRACE_MS ?? 10 * 60 * 1000);
export const MAX_SESSIONS_PER_USER = 8;
export const MAX_DETACHED_PER_USER = 3;
export const MAX_SESSIONS_GLOBAL = 200;
export const SESSION_TAKEOVER_CODE = 4409;
export const SESSION_LIMIT_CODE = 4429;

export type SessionState = 'attached' | 'detached' | 'dying';
export type AttachReason = 'new' | 'resumed' | 'expired' | 'moved' | 'denied';

export const replicaId = hostname();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PREFIX = 'orchard:exec:sess:';

export interface SizedOutput extends PassThrough {
  columns: number;
  rows: number;
  setSize(columns: number, rows: number): void;
}

export class ResizableOutput extends PassThrough implements SizedOutput {
  columns = 80;

  rows = 24;

  setSize(columns: number, rows: number): void {
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return;
    const nextCols = Math.max(1, Math.min(1000, Math.floor(columns)));
    const nextRows = Math.max(1, Math.min(1000, Math.floor(rows)));
    if (nextCols === this.columns && nextRows === this.rows) return;
    this.columns = nextCols;
    this.rows = nextRows;
    this.emit('resize');
  }
}

export interface PodExecTarget {
  kind: 'pod';
  namespace: string;
  podName: string;
  container: string;
  projectId: string;
  organizationId: string;
}

export interface ExtensionExecTarget {
  kind: string;
  key: string;
  [field: string]: unknown;
}

export type ExecTarget = PodExecTarget | ExtensionExecTarget;

export function isPodTarget(target: ExecTarget): target is PodExecTarget {
  return target.kind === 'pod' && 'podName' in target;
}

export function targetKey(target: ExecTarget): string {
  if (isPodTarget(target)) {
    return `pod:${target.namespace}/${target.podName}/${target.container}`;
  }
  return (target as ExtensionExecTarget).key;
}

export function clampTerminalSize(
  cols: number,
  rows: number
): { cols: number; rows: number } | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.max(1, Math.min(1000, Math.floor(cols))),
    rows: Math.max(1, Math.min(1000, Math.floor(rows)))
  };
}

export interface ExecSession {
  id: string;
  handle: string;
  ownerUserId: string;
  target: ExecTarget;
  targetKey: string;
  upstream: PtyHandle | null;
  stdin: Writable;
  cols: number;
  rows: number;
  screen: SessionScreen;
  proto: Proto;
  reusedId: boolean;
  browser: WebSocket | null;
  state: SessionState;
  createdAt: number;
  detachedAt: number | null;
  graceTimer: NodeJS.Timeout | null;
  recheckTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  activityTimer: NodeJS.Timeout | null;
  recheckAuth: () => Promise<boolean>;
  paused: boolean;
  exited: boolean;
}

export const sessions = new Map<string, ExecSession>();
export const sessionsByUser = new Map<string, Set<string>>();

function secret(): Buffer {
  return Buffer.from(process.env.JWT_SECRET || '', 'utf8');
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function mac(prefix: string): Buffer {
  return createHmac('sha256', secret()).update(prefix).digest().subarray(0, 16);
}

export function makeHandle(id: string): string {
  const prefix = `v1.${b64url(replicaId)}.${id}`;
  return `${prefix}.${b64url(mac(prefix))}`;
}

export function parseHandle(handle: string): { replica: string; id: string } | null {
  const parts = handle.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, rep, id, given] = parts;
  if (!UUID_RE.test(id)) return null;
  let givenMac: Buffer;
  let replica: string;
  try {
    givenMac = Buffer.from(given, 'base64url');
    replica = Buffer.from(rep, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = mac(`v1.${rep}.${id}`);
  if (givenMac.length !== expected.length || !timingSafeEqual(givenMac, expected)) return null;
  if (!replica) return null;
  return { replica, id: id.toLowerCase() };
}

export function track(session: ExecSession): void {
  sessions.set(session.id, session);
  let ids = sessionsByUser.get(session.ownerUserId);
  if (!ids) {
    ids = new Set();
    sessionsByUser.set(session.ownerUserId, ids);
  }
  ids.add(session.id);
}

export function untrack(session: ExecSession): void {
  sessions.delete(session.id);
  const ids = sessionsByUser.get(session.ownerUserId);
  if (!ids) return;
  ids.delete(session.id);
  if (ids.size === 0) sessionsByUser.delete(session.ownerUserId);
}

export function userSessions(userId: string): ExecSession[] {
  const ids = sessionsByUser.get(userId);
  if (!ids) return [];
  const out: ExecSession[] = [];
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) out.push(s);
  }
  return out;
}

export function overLimit(userId: string): boolean {
  if (sessions.size >= MAX_SESSIONS_GLOBAL) return true;
  return userSessions(userId).length >= MAX_SESSIONS_PER_USER;
}

export function oldestDetachedBeyondCap(userId: string): ExecSession[] {
  const detached = userSessions(userId)
    .filter((s) => s.state === 'detached')
    .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
  const excess = detached.length - MAX_DETACHED_PER_USER;
  return excess > 0 ? detached.slice(0, excess) : [];
}

export interface DirectoryEntry {
  replica: string;
  addr: string;
  ownerUserId: string;
  targetKey?: string;
  namespace?: string;
  podName?: string;
  container?: string;
}

export function directoryEntry(
  replica: string,
  addr: string,
  ownerUserId: string,
  target: ExecTarget
): DirectoryEntry {
  const entry: DirectoryEntry = { replica, addr, ownerUserId, targetKey: targetKey(target) };
  if (isPodTarget(target)) {
    entry.namespace = target.namespace;
    entry.podName = target.podName;
    entry.container = target.container;
  }
  return entry;
}

export function entryTargetKey(entry: DirectoryEntry): string | null {
  if (typeof entry.targetKey === 'string' && entry.targetKey) return entry.targetKey;
  if (typeof entry.namespace === 'string' && typeof entry.podName === 'string') {
    return `pod:${entry.namespace}/${entry.podName}/${entry.container ?? ''}`;
  }
  return null;
}

export class ExecSessionDirectory {
  private redis: Redis | null = null;

  private readonly memory = new Map<string, { value: DirectoryEntry; expiresAt: number }>();

  constructor(private readonly warn: (message: string) => void) {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', (e) => this.warn(`exec session directory redis error: ${e.message}`));
  }

  async set(id: string, value: DirectoryEntry, ttlMs: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(KEY_PREFIX + id, JSON.stringify(value), 'PX', ttlMs);
        return;
      } catch (error) {
        this.warn(`exec session directory set failed: ${(error as Error).message}`);
      }
    }
    this.memory.set(id, { value, expiresAt: Date.now() + ttlMs });
  }

  async get(id: string): Promise<DirectoryEntry | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(KEY_PREFIX + id);
        if (raw) return JSON.parse(raw) as DirectoryEntry;
      } catch (error) {
        this.warn(`exec session directory get failed: ${(error as Error).message}`);
      }
    }
    const hit = this.memory.get(id);
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expiresAt < now) this.memory.delete(k);
    }
    if (!hit || hit.expiresAt < now) return null;
    return hit.value;
  }

  async del(id: string): Promise<void> {
    this.memory.delete(id);
    if (!this.redis) return;
    try {
      await this.redis.del(KEY_PREFIX + id);
    } catch (error) {
      this.warn(`exec session directory del failed: ${(error as Error).message}`);
    }
  }

  close(): void {
    try {
      this.redis?.disconnect();
    } catch {
      return;
    }
  }
}
