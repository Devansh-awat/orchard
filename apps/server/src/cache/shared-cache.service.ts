import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

const PREFIX = 'orchard:cache:';
const LOCAL_LIMIT = 2_000;
const LOCK_MS = 60_000;

interface Stamped<T> {
  at: number;
  value: T;
}

export interface SnapshotOptions {
  freshMs: number;
  keepMs: number;
}

@Injectable()
export class SharedCache implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SharedCache.name);
  private redis: Redis | null = null;
  private readonly local = new Map<string, { expires: number; raw: string }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1500
    });
    this.redis.on('error', (e) => this.logger.warn(`shared cache redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  private get live(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  private async readRaw(key: string): Promise<string | null> {
    const redis = this.live;
    if (redis) {
      try {
        return await redis.get(PREFIX + key);
      } catch {}
    }
    const hit = this.local.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      this.local.delete(key);
      return null;
    }
    return hit.raw;
  }

  private async writeRaw(key: string, raw: string, ttlMs: number): Promise<void> {
    const redis = this.live;
    if (redis) {
      try {
        await redis.set(PREFIX + key, raw, 'PX', Math.max(1, Math.round(ttlMs)));
        return;
      } catch {}
    }
    if (this.local.size >= LOCAL_LIMIT) this.local.clear();
    this.local.set(key, { expires: Date.now() + ttlMs, raw });
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.readRaw(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.writeRaw(key, JSON.stringify(value), ttlMs);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    for (const key of keys) this.local.delete(key);
    const redis = this.live;
    if (!redis) return;
    try {
      await redis.del(...keys.map((k) => PREFIX + k));
    } catch {}
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const next = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, next);
    return next;
  }

  async remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<Stamped<T>>(key);
    if (hit) return hit.value;
    return this.once(key, async () => {
      const value = await load();
      await this.set<Stamped<T>>(key, { at: Date.now(), value }, ttlMs);
      return value;
    });
  }

  async snapshot<T>(key: string, opts: SnapshotOptions, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<Stamped<T>>(key);
    const refresh = () =>
      this.once(key, async () => {
        const value = await load();
        await this.set<Stamped<T>>(key, { at: Date.now(), value }, opts.keepMs);
        return value;
      });
    if (!hit) return refresh();
    if (Date.now() - hit.at >= opts.freshMs) void this.refreshInBackground(key, refresh);
    return hit.value;
  }

  private async refreshInBackground(key: string, refresh: () => Promise<unknown>) {
    if (this.inFlight.has(key)) return;
    const redis = this.live;
    if (redis) {
      const locked = await redis
        .set(`${PREFIX}${key}:lock`, '1', 'PX', LOCK_MS, 'NX')
        .catch(() => 'OK');
      if (locked !== 'OK') return;
    }
    try {
      await refresh();
    } catch (err) {
      this.logger.warn(`refresh of ${key} failed: ${(err as Error).message}`);
    } finally {
      await redis?.del(`${PREFIX}${key}:lock`).catch(() => undefined);
    }
  }
}
