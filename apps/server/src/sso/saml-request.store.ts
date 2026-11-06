import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import type { CacheItem, CacheProvider } from '@node-saml/node-saml';

const TTL_MS = 15 * 60 * 1000;
const KEY_PREFIX = 'orchard:saml:request:';

interface Entry {
  item: CacheItem;
  expiresAt: number;
}

@Injectable()
export class SamlRequestStore implements CacheProvider, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SamlRequestStore.name);

  private readonly memory = new Map<string, Entry>();

  private redis: Redis | null = null;

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn(
          'REDIS_URL not set: SAML request ids are per-pod; SSO breaks with multiple replicas'
        );
      }
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', (e) => this.logger.warn(`saml redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    return (await this.put(key, value, TTL_MS)) ? { value, createdAt: Date.now() } : null;
  }

  async getAsync(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const value = await this.redis.get(KEY_PREFIX + key);
        if (value !== null) return value;
      } catch (error) {
        this.logger.warn(`saml redis get failed, using memory: ${(error as Error).message}`);
      }
    }
    this.prune();
    return this.memory.get(key)?.item.value ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    return this.take(key);
  }

  async put(key: string, value: string, ttlMs: number = TTL_MS): Promise<boolean> {
    if (this.redis) {
      try {
        const stored = await this.redis.set(KEY_PREFIX + key, value, 'PX', ttlMs, 'NX');
        return Boolean(stored);
      } catch (error) {
        this.logger.warn(`saml redis save failed, using memory: ${(error as Error).message}`);
      }
    }
    this.prune();
    if (this.memory.has(key)) return false;
    this.memory.set(key, {
      item: { value, createdAt: Date.now() },
      expiresAt: Date.now() + ttlMs
    });
    return true;
  }

  async take(key: string): Promise<string | null> {
    let removed: string | null = null;
    if (this.redis) {
      try {
        removed = await this.redis.getdel(KEY_PREFIX + key);
      } catch (error) {
        this.logger.warn(`saml redis remove failed, using memory: ${(error as Error).message}`);
      }
    }
    this.prune();
    const hit = this.memory.get(key);
    this.memory.delete(key);
    return removed ?? hit?.item.value ?? null;
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
  }
}
