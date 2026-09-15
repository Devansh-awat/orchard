import { createHmac, timingSafeEqual } from 'crypto';
import { hostname } from 'os';
import Redis from 'ioredis';
import type WebSocket from 'ws';
import type { PassThrough } from 'stream';

export const DETACH_GRACE_MS = Number(process.env.EXEC_DETACH_GRACE_MS ?? 10 * 60 * 1000);
export const RING_BYTES = 256 * 1024;
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

export class RingBuffer {
  private chunks: Buffer[] = [];

  private size = 0;

  truncated = false;

  constructor(private readonly cap = RING_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size = this.cap;
      }
      this.truncated = true;
    }
  }

  drain(): Buffer {
    const out = Buffer.concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    return out;
  }

  get length(): number {
    return this.size;
  }
}

export interface SizedOutput extends PassThrough {
  columns: number;
  rows: number;
  setSize(columns: number, rows: number): void;
  forceResize(columns: number, rows: number): void;
}

export interface ExecSession {
  id: string;
  handle: string;
  ownerUserId: string;
  namespace: string;
  podName: string;
  container: string;
  projectId: string;
  organizationId: string;
  upstream: WebSocket | null;
  stdin: PassThrough;
  stdout: SizedOutput;
  stderr: PassThrough;
  ring: RingBuffer;
  browser: WebSocket | null;
  state: SessionState;
  createdAt: number;
  detachedAt: number | null;
  graceTimer: NodeJS.Timeout | null;
  recheckTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
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
  namespace: string;
  podName: string;
  container: string;
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
