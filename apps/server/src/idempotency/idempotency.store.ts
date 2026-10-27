import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

export type IdempotencyRecord =
  | { state: 'pending'; fingerprint: string }
  | { state: 'done'; fingerprint: string; status: number; body: unknown };

export interface IdempotencyStore {
  readonly available: boolean;
  claim(key: string, fingerprint: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<IdempotencyRecord | null>;
  complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
}

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

const KEY_PREFIX = 'orchard:idempotency:';

@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisIdempotencyStore.name);

  private redis: Redis | null = null;

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2000
    });
    this.redis.on('error', (e) => this.logger.warn(`idempotency redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  get available(): boolean {
    return this.redis !== null && this.redis.status === 'ready';
  }

  async claim(key: string, fingerprint: string, ttlMs: number): Promise<boolean> {
    if (!this.redis) return true;
    const record: IdempotencyRecord = { state: 'pending', fingerprint };
    const ok = await this.redis.set(KEY_PREFIX + key, JSON.stringify(record), 'PX', ttlMs, 'NX');
    return ok === 'OK';
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(KEY_PREFIX + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  async complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(KEY_PREFIX + key, JSON.stringify(record), 'PX', ttlMs);
  }

  async release(key: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(KEY_PREFIX + key);
  }
}
