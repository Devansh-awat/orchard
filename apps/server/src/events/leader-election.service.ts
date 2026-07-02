import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'os';

const LOCK_KEY = 'orchard:informer:leader';
const TTL_MS = 15_000;
const RENEW_MS = 5_000;

const RENEW_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
elseif v == false then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
else
  return 0
end`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly instanceId = `${hostname()}-${process.pid}`;
  private redis: Redis | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private leader = false;
  private lastLeaderAt = 0;

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set — single-instance mode, this replica is always leader');
      this.leader = true;
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    this.redis.on('error', (e) => this.logger.warn(`leader redis error: ${e.message}`));
    void this.tick();
    this.timer = setInterval(() => void this.tick(), RENEW_MS);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.redis && this.leader) {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, this.instanceId);
      } catch {}
    }
    try {
      this.redis?.disconnect();
    } catch {}
  }

  isLeader(): boolean {
    if (!this.redis) return this.leader;
    return this.leader && Date.now() - this.lastLeaderAt < TTL_MS;
  }

  private async tick() {
    if (!this.redis) return;
    try {
      const res = (await this.redis.eval(
        RENEW_SCRIPT,
        1,
        LOCK_KEY,
        this.instanceId,
        String(TTL_MS),
      )) as number;
      const wasLeader = this.leader;
      this.leader = res === 1;
      if (this.leader) this.lastLeaderAt = Date.now();
      if (this.leader && !wasLeader) this.logger.log(`acquired informer leadership (${this.instanceId})`);
      if (!this.leader && wasLeader) this.logger.log('lost informer leadership');
    } catch (e) {
      this.logger.warn(`leader tick failed: ${(e as Error).message}`);
    }
  }
}
