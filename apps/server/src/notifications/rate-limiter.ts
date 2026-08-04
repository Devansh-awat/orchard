import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

// Provider limits, not ours. Slack throttles an incoming webhook at roughly one
// message per second with a short burst allowance; Discord is 5 per 2s per
// webhook. Exceeding these gets the webhook blocked, which is a much worse
// outcome than a delivery arriving a second late.
const BUCKETS: Record<string, { capacity: number; refillPerSec: number }> = {
  slack: { capacity: 5, refillPerSec: 1 },
  discord: { capacity: 5, refillPerSec: 2.5 },
  webhook: { capacity: 20, refillPerSec: 10 },
  email: { capacity: 20, refillPerSec: 0.33 },
};

// Take a token if one is available, otherwise report how long until the next
// one. Atomic so replicas share one budget per destination.
const TAKE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / refill * 1000)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill * 1000) + 60000)
return wait`;

interface LocalBucket {
  tokens: number;
  ts: number;
}

// Losing this state costs at most one extra send, which is exactly why it is
// the only part of the pipeline allowed to live in Redis. Everything durable
// lives in Postgres.
@Injectable()
export class NotificationRateLimiter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRateLimiter.name);

  private redis: Redis | null = null;

  private readonly local = new Map<string, LocalBucket>();

  private readonly localCooldowns = new Map<string, number>();

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set — notification rate limiting is per-process only');
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    this.redis.on('error', (e) => this.logger.warn(`rate limiter redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
    this.local.clear();
    this.localCooldowns.clear();
  }

  // Returns 0 when a token was taken, otherwise the milliseconds to wait. The
  // caller parks the delivery rather than sleeping, so a slow destination never
  // holds a worker slot.
  async take(destinationKey: string, type: string): Promise<number> {
    const bucket = BUCKETS[type] ?? BUCKETS.webhook;
    if (!this.redis) return this.takeLocal(destinationKey, bucket);
    try {
      const wait = await this.redis.eval(
        TAKE_SCRIPT,
        1,
        `orchard:notif:bucket:${destinationKey}`,
        String(bucket.capacity),
        String(bucket.refillPerSec),
        String(Date.now()),
      );
      return Number(wait) || 0;
    } catch (e: any) {
      this.logger.warn(`rate limiter fell back to local bucket: ${e?.message ?? e}`);
      return this.takeLocal(destinationKey, bucket);
    }
  }

  // Suppresses a repeat of the same alert about the same thing. Distinct from
  // the token bucket: that one paces a destination, this one stops a flapping
  // resource from saying the same sentence every minute.
  async shouldSuppress(destinationKey: string, event: string, targetId: string | null, ttlMs: number): Promise<boolean> {
    if (ttlMs <= 0) return false;
    const key = `orchard:notif:cooldown:${destinationKey}:${event}:${targetId ?? '-'}`;
    if (!this.redis) return this.suppressLocal(key, ttlMs);
    try {
      const set = await this.redis.set(key, '1', 'PX', ttlMs, 'NX');
      return set === null;
    } catch {
      return this.suppressLocal(key, ttlMs);
    }
  }

  private takeLocal(destinationKey: string, bucket: { capacity: number; refillPerSec: number }): number {
    const now = Date.now();
    const state = this.local.get(destinationKey) ?? { tokens: bucket.capacity, ts: now };
    const elapsed = Math.max(0, now - state.ts) / 1000;
    let tokens = Math.min(bucket.capacity, state.tokens + elapsed * bucket.refillPerSec);
    let wait = 0;
    if (tokens >= 1) tokens -= 1;
    else wait = Math.ceil(((1 - tokens) / bucket.refillPerSec) * 1000);
    this.local.set(destinationKey, { tokens, ts: now });
    if (this.local.size > 5000) this.pruneLocal(now);
    return wait;
  }

  private suppressLocal(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const expiresAt = this.localCooldowns.get(key);
    if (expiresAt && expiresAt > now) return true;
    this.localCooldowns.set(key, now + ttlMs);
    if (this.localCooldowns.size > 5000) {
      for (const [k, exp] of this.localCooldowns) {
        if (exp <= now) this.localCooldowns.delete(k);
      }
    }
    return false;
  }

  private pruneLocal(now: number) {
    for (const [k, v] of this.local) {
      if (now - v.ts > 10 * 60_000) this.local.delete(k);
    }
  }
}
