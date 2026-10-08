import { randomUUID } from 'crypto';
import Redis from 'ioredis';

export const LIVE_CHANNEL_PREFIX = 'sbx-live:';

export const liveChannel = (sandboxId: string) => `${LIVE_CHANNEL_PREFIX}${sandboxId}`;

export type LiveMessageHandler = (channel: string, message: string) => void;

export interface LiveBackend {
  readonly replicaId: string;
  readonly shared: boolean;
  publish(channel: string, message: string): Promise<void>;
  onMessage(handler: LiveMessageHandler): () => void;
  hset(key: string, field: string, value: string, ttlMs: number): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  claim(key: string, value: string, ttlMs: number): Promise<string>;
  refresh(key: string, value: string, ttlMs: number): Promise<boolean>;
  release(key: string, value: string): Promise<void>;
  put(key: string, value: string, ttlMs: number): Promise<void>;
  take(key: string): Promise<string | null>;
  close(): Promise<void>;
}

const REFRESH_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const CLAIM_LUA = `local cur = redis.call('get', KEYS[1]) if cur then return cur end redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return ARGV[1]`;

export class RedisLiveBackend implements LiveBackend {
  readonly replicaId = randomUUID();

  readonly shared = true;

  private readonly pub: Redis;

  private readonly sub: Redis;

  private readonly handlers = new Set<LiveMessageHandler>();

  constructor(url: string, warn: (message: string) => void) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.pub.on('error', (e) => warn(`live redis error: ${e.message}`));
    this.sub.on('error', (e) => warn(`live redis subscriber error: ${e.message}`));
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      for (const handler of this.handlers) handler(channel, message);
    });
    this.sub.psubscribe(`${LIVE_CHANNEL_PREFIX}*`).catch((e) => {
      warn(`live redis psubscribe failed: ${e?.message}`);
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }

  onMessage(handler: LiveMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async hset(key: string, field: string, value: string, ttlMs: number): Promise<void> {
    await this.pub.multi().hset(key, field, value).pexpire(key, ttlMs).exec();
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.pub.hdel(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return (await this.pub.hgetall(key)) ?? {};
  }

  async claim(key: string, value: string, ttlMs: number): Promise<string> {
    return String(await this.pub.eval(CLAIM_LUA, 1, key, value, String(ttlMs)));
  }

  async refresh(key: string, value: string, ttlMs: number): Promise<boolean> {
    return Number(await this.pub.eval(REFRESH_LUA, 1, key, value, String(ttlMs))) === 1;
  }

  async release(key: string, value: string): Promise<void> {
    await this.pub.eval(RELEASE_LUA, 1, key, value);
  }

  async put(key: string, value: string, ttlMs: number): Promise<void> {
    await this.pub.set(key, value, 'PX', ttlMs);
  }

  async take(key: string): Promise<string | null> {
    const result = await this.pub.multi().get(key).del(key).exec();
    const value = result?.[0]?.[1];
    return typeof value === 'string' ? value : null;
  }

  async close(): Promise<void> {
    this.handlers.clear();
    try {
      this.sub.disconnect();
    } catch {}
    try {
      this.pub.disconnect();
    } catch {}
  }
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export class MemoryLiveNetwork {
  readonly kv = new Map<string, MemoryEntry>();

  readonly hashes = new Map<string, { fields: Map<string, string>; expiresAt: number }>();

  readonly members = new Set<MemoryLiveBackend>();

  private alive(entry: { expiresAt: number } | undefined): boolean {
    return !!entry && entry.expiresAt > Date.now();
  }

  get(key: string): string | null {
    const entry = this.kv.get(key);
    if (!this.alive(entry)) {
      this.kv.delete(key);
      return null;
    }
    return entry!.value;
  }

  hash(key: string): Map<string, string> | null {
    const entry = this.hashes.get(key);
    if (!this.alive(entry)) {
      this.hashes.delete(key);
      return null;
    }
    return entry!.fields;
  }
}

export class MemoryLiveBackend implements LiveBackend {
  readonly replicaId: string;

  readonly shared: boolean;

  private readonly handlers = new Set<LiveMessageHandler>();

  private closed = false;

  constructor(
    private readonly network: MemoryLiveNetwork = new MemoryLiveNetwork(),
    replicaId: string = randomUUID()
  ) {
    this.replicaId = replicaId;
    this.shared = false;
    network.members.add(this);
  }

  deliver(channel: string, message: string): void {
    if (this.closed) return;
    for (const handler of this.handlers) handler(channel, message);
  }

  async publish(channel: string, message: string): Promise<void> {
    const targets = [...this.network.members];
    setImmediate(() => {
      for (const member of targets) member.deliver(channel, message);
    });
  }

  onMessage(handler: LiveMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async hset(key: string, field: string, value: string, ttlMs: number): Promise<void> {
    const fields = this.network.hash(key) ?? new Map<string, string>();
    fields.set(field, value);
    this.network.hashes.set(key, { fields, expiresAt: Date.now() + ttlMs });
  }

  async hdel(key: string, field: string): Promise<void> {
    this.network.hash(key)?.delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.network.hash(key) ?? []);
  }

  async claim(key: string, value: string, ttlMs: number): Promise<string> {
    const current = this.network.get(key);
    if (current !== null) return current;
    this.network.kv.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  async refresh(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.network.get(key) !== value) return false;
    this.network.kv.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async release(key: string, value: string): Promise<void> {
    if (this.network.get(key) === value) this.network.kv.delete(key);
  }

  async put(key: string, value: string, ttlMs: number): Promise<void> {
    this.network.kv.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async take(key: string): Promise<string | null> {
    const value = this.network.get(key);
    this.network.kv.delete(key);
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    this.network.members.delete(this);
  }
}

export function createLiveBackend(warn: (message: string) => void): LiveBackend {
  const url = process.env.REDIS_URL;
  if (url) return new RedisLiveBackend(url, warn);
  return new MemoryLiveBackend();
}
