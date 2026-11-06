import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  RateLimitService,
  RATE_LIMIT_CONFIGS,
  COLLAPSED_IP_MULTIPLIER,
  COLLAPSED_IP_MAX_BLOCK_MS,
  CLEANUP_BATCH
} from '../src/auth/rate-limit.service';
import { AuthCleanupService } from '../src/auth/auth-cleanup.service';
import { GLOBAL_LEADER_LEASE } from '../src/coordination/lease.service';
import { OtpService } from '../src/auth/otp.service';

process.env.JWT_SECRET ??= 'test-secret-for-otp-hash';

function memoryThrottle() {
  const buckets = new Map<string, { count: number; blockedUntil: number; config: any }>();
  return {
    buckets,
    available: true,
    retryAfter: async () => null,
    hit: async () => false,
    clear: async () => false,
    consume: async (key: string, config: any) => {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { count: 0, blockedUntil: 0, config };
      if (bucket.blockedUntil > now) return Math.ceil((bucket.blockedUntil - now) / 1000);
      bucket.count += 1;
      buckets.set(key, bucket);
      if (bucket.count > config.maxAttempts) {
        bucket.blockedUntil = now + config.blockDurationMs;
        return Math.ceil(config.blockDurationMs / 1000);
      }
      return 0;
    }
  };
}

async function blocked(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof HttpException && e.getStatus() === 429;
  }
}

test('a public source is capped at its own per-ip limit and blocked alone', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts;
  for (let i = 0; i < cap; i++) await svc.checkRateLimit('203.0.113.1', 'ip', 'otp_request');
  assert.equal(await blocked(svc.checkRateLimit('203.0.113.1', 'ip', 'otp_request')), true);
  assert.equal(await blocked(svc.checkRateLimit('203.0.113.2', 'ip', 'otp_request')), false);
});

test('one source cannot spend the global ceiling', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  for (let i = 0; i < 500; i++) {
    await svc.checkRateLimit('203.0.113.1', 'ip', 'otp_request').catch(() => undefined);
  }
  const global = throttle.buckets.get('otp_request:global:all')!;
  assert.ok(global.count <= RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts + 500);
  assert.ok(global.count < RATE_LIMIT_CONFIGS.otp_request_global.maxAttempts);
  assert.equal(await blocked(svc.checkRateLimit('203.0.113.9', 'ip', 'otp_request')), false);
});

test('the global ceiling stops a distributed flood', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const ceiling = RATE_LIMIT_CONFIGS.otp_request_global.maxAttempts;
  for (let i = 0; i < ceiling; i++) {
    await svc.checkRateLimit(`198.51.${(i >> 8) & 255}.${i & 255}`, 'ip', 'otp_request');
  }
  assert.equal(await blocked(svc.checkRateLimit('192.0.2.77', 'ip', 'otp_request')), true);
});

test('a collapsed address gets a wider, shorter-lived bucket so it cannot lock everyone out for an hour', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts * COLLAPSED_IP_MULTIPLIER;
  for (let i = 0; i < cap; i++) await svc.checkRateLimit('10.42.1.5', 'ip', 'otp_request');
  assert.equal(await blocked(svc.checkRateLimit('10.42.1.5', 'ip', 'otp_request')), true);
  const bucket = throttle.buckets.get('otp_request:ip:10.42.1.5')!;
  assert.ok(bucket.blockedUntil - Date.now() <= COLLAPSED_IP_MAX_BLOCK_MS);
  assert.ok(bucket.config.blockDurationMs <= COLLAPSED_IP_MAX_BLOCK_MS);
});

test('email buckets stay independent of the ip bucket', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_email.maxAttempts;
  for (let i = 0; i < cap; i++) await svc.checkRateLimit('a@example.com', 'email', 'otp_request');
  assert.equal(await blocked(svc.checkRateLimit('a@example.com', 'email', 'otp_request')), true);
  assert.equal(await blocked(svc.checkRateLimit('b@example.com', 'email', 'otp_request')), false);
});

test('an ip-blocked request never creates an email bucket', async () => {
  const throttle = memoryThrottle();
  const rate = new RateLimitService({} as any, throttle as any);
  const otp = new OtpService(
    {
      otpCode: { updateMany: async () => ({ count: 0 }), create: async () => ({}) }
    } as any,
    { isConfigured: () => true, sendOtpEmail: async () => true } as any,
    rate
  );
  const cap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts;
  for (let i = 0; i < cap; i++) await otp.requestOtp(`user${i}@example.com`, '203.0.113.5');
  const before = throttle.buckets.size;
  await assert.rejects(otp.requestOtp('fresh@example.com', '203.0.113.5'));
  assert.equal(throttle.buckets.size, before);
  assert.equal(throttle.buckets.has('otp_request:email:fresh@example.com'), false);
});

function fakeTable(total: number) {
  let rows = Array.from({ length: total }, (_, i) => ({ id: String(i) }));
  const calls = { find: 0, del: 0, deleteSizes: [] as number[] };
  return {
    calls,
    remaining: () => rows.length,
    findMany: async ({ take }: any) => {
      calls.find++;
      return rows.slice(0, take);
    },
    deleteMany: async ({ where }: any) => {
      calls.del++;
      const ids = new Set(where.id.in);
      calls.deleteSizes.push(ids.size);
      const before = rows.length;
      rows = rows.filter((r) => !ids.has(r.id));
      return { count: before - rows.length };
    }
  };
}

test('cleanup deletes expired rate limit rows in bounded batches', async () => {
  const table = fakeTable(CLEANUP_BATCH * 2 + 5);
  const svc = new RateLimitService({ rateLimitRecord: table } as any, memoryThrottle() as any);
  const removed = await svc.cleanupExpiredRecords();
  assert.equal(removed, CLEANUP_BATCH * 2 + 5);
  assert.ok(table.calls.deleteSizes.every((n) => n <= CLEANUP_BATCH));
});

test('the scheduled cleanup only runs on the lease holder', async () => {
  const ran: string[] = [];
  const mk = (name: string) => async () => {
    ran.push(name);
    return 0;
  };
  const make = (canCoordinate: boolean, holder: boolean) =>
    new AuthCleanupService(
      {
        canCoordinate,
        isHolder: (name: string) => holder && name === GLOBAL_LEADER_LEASE
      } as any,
      { cleanupExpiredRecords: mk('rate') } as any,
      { cleanupExpiredCodes: mk('otp') } as any,
      { cleanupExpiredChallenges: mk('challenge') } as any
    );
  await make(false, true).tick();
  await make(true, false).tick();
  assert.deepEqual(ran, []);
  await make(true, true).tick();
  assert.deepEqual(ran.sort(), ['challenge', 'otp', 'rate']);
});

test('one failing cleanup does not stop the others', async () => {
  const ran: string[] = [];
  const svc = new AuthCleanupService(
    { canCoordinate: true, isHolder: () => true } as any,
    {
      cleanupExpiredRecords: async () => {
        throw new Error('boom');
      }
    } as any,
    {
      cleanupExpiredCodes: async () => {
        ran.push('otp');
        return 0;
      }
    } as any,
    {
      cleanupExpiredChallenges: async () => {
        ran.push('challenge');
        return 0;
      }
    } as any
  );
  await svc.tick();
  assert.deepEqual(ran.sort(), ['challenge', 'otp']);
});
