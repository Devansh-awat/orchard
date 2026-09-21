import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

export interface ThrottleWindow {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs: number;
}

const RETRY_AFTER_SCRIPT = `
local st = redis.call('HMGET', KEYS[1], 'count', 'ws', 'bu')
local count = tonumber(st[1])
if count == nil then return 0 end
local ws = tonumber(st[2]) or 0
local bu = tonumber(st[3]) or 0
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
if bu > now then return math.ceil((bu - now) / 1000) end
if (now - ws) > windowMs then return 0 end
if count >= max then return math.ceil(blockMs / 1000) end
return 0`;

const HIT_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local st = redis.call('HMGET', key, 'count', 'ws')
local count = tonumber(st[1])
local ws = tonumber(st[2])
if count == nil or ws == nil or (now - ws) > windowMs then
  redis.call('HMSET', key, 'count', 1, 'ws', now, 'bu', 0)
  count = 1
else
  count = count + 1
  redis.call('HSET', key, 'count', count)
  if count >= max then redis.call('HSET', key, 'bu', now + blockMs) end
end
local ttl = windowMs
if count >= max then ttl = windowMs + blockMs end
redis.call('PEXPIRE', key, ttl + 60000)
return count`;

const KEY_PREFIX = 'orchard:throttle:';

@Injectable()
export class RedisThrottleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottleService.name);

  private redis: Redis | null = null;

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set: attempt counters are per-pod, so every limit multiplies by replica count'
      );
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', (e) => this.logger.warn(`throttle redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  get available(): boolean {
    return this.redis !== null;
  }

  private args(config: ThrottleWindow): string[] {
    return [
      String(config.maxAttempts),
      String(config.windowMs),
      String(config.blockDurationMs),
      String(Date.now())
    ];
  }

  async retryAfter(key: string, config: ThrottleWindow): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const seconds = await this.redis.eval(
        RETRY_AFTER_SCRIPT,
        1,
        KEY_PREFIX + key,
        ...this.args(config)
      );
      return Number(seconds) || 0;
    } catch (e: any) {
      this.logger.warn(`throttle read fell back: ${e?.message ?? e}`);
      return null;
    }
  }

  async hit(key: string, config: ThrottleWindow): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.eval(HIT_SCRIPT, 1, KEY_PREFIX + key, ...this.args(config));
      return true;
    } catch (e: any) {
      this.logger.warn(`throttle write fell back: ${e?.message ?? e}`);
      return false;
    }
  }

  async clear(key: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.del(KEY_PREFIX + key);
      return true;
    } catch (e: any) {
      this.logger.warn(`throttle clear fell back: ${e?.message ?? e}`);
      return false;
    }
  }
}
