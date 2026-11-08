import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  RateLimitService,
  RATE_LIMIT_CONFIGS,
  COLLAPSED_IP_MULTIPLIER,
  COLLAPSED_IP_MAX_BLOCK_MS,
  CLEANUP_BATCH,
  PRESSURE_DELAY_MS,
  PRESSURE_MAX_SLEEPERS
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

test('one attacker address cannot consume the global budget or lock honest addresses out', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const ipCap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts;
  let rejected = 0;
  for (let i = 0; i < 3100; i++) {
    await svc
      .checkRateLimits('otp_request', {
        ip: '203.0.113.1',
        identities: [[`junk${i}@example.com`, 'email']]
      })
      .catch(() => rejected++);
  }
  assert.equal(rejected, 3100 - ipCap);
  const global = throttle.buckets.get('otp_request:global:all')!;
  assert.equal(global.count, ipCap);
  for (let i = 0; i < 200; i++) {
    const result = await svc.checkRateLimits('otp_request', {
      ip: `198.51.100.${i}`,
      identities: [[`honest${i}@example.com`, 'email']]
    });
    assert.equal(result.pressured, false);
  }
});

test('requests rejected on the identity bucket do not charge the global budget', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_email.maxAttempts;
  for (let i = 0; i < cap; i++) {
    await svc.checkRateLimits('otp_request', {
      ip: `192.0.2.${i}`,
      identities: [['victim@example.com', 'email']]
    });
  }
  const before = throttle.buckets.get('otp_request:global:all')!.count;
  for (let i = 0; i < 50; i++) {
    await svc
      .checkRateLimits('otp_request', {
        ip: `192.0.2.${100 + i}`,
        identities: [['victim@example.com', 'email']]
      })
      .catch(() => undefined);
  }
  assert.equal(throttle.buckets.get('otp_request:global:all')!.count, before);
});

test('a distributed flood past the ceiling degrades to a step-up instead of a hard block', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const ceiling = RATE_LIMIT_CONFIGS.otp_request_global.maxAttempts;
  for (let i = 0; i < ceiling; i++) {
    const result = await svc.checkRateLimits('otp_request', {
      ip: `198.51.${(i >> 8) & 255}.${i & 255}`
    });
    assert.equal(result.pressured, false);
  }
  const result = await svc.checkRateLimits('otp_request', { ip: '192.0.2.77' });
  assert.equal(result.pressured, true);
  assert.equal(await blocked(svc.checkRateLimit('192.0.2.77', 'ip', 'otp_request')), false);
});

test('slowDown never lets the number of sleepers grow without bound', async () => {
  const svc = new RateLimitService({} as any, memoryThrottle() as any);
  (svc as any).sleepers = PRESSURE_MAX_SLEEPERS;
  const started = Date.now();
  await svc.slowDown();
  assert.ok(Date.now() - started < PRESSURE_DELAY_MS / 2);
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

test('an IPv6 client rotating addresses inside its /64 shares one bucket', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts;
  for (let i = 0; i < cap; i++) {
    await svc.checkRateLimit(`2001:db8:aa:bb:${i.toString(16)}::1`, 'ip', 'otp_request');
  }
  assert.equal(
    await blocked(svc.checkRateLimit('2001:db8:aa:bb:ffff:1:2:3', 'ip', 'otp_request')),
    true
  );
  assert.equal(await blocked(svc.checkRateLimit('2001:db8:aa:cc::1', 'ip', 'otp_request')), false);
  assert.equal(await blocked(svc.checkRateLimit('203.0.113.9', 'ip', 'otp_request')), false);
});

test('an IPv4-mapped IPv6 address shares the bucket of its IPv4', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  const cap = RATE_LIMIT_CONFIGS.otp_request_ip.maxAttempts;
  for (let i = 0; i < cap; i++) await svc.checkRateLimit('203.0.113.9', 'ip', 'otp_request');
  assert.equal(await blocked(svc.checkRateLimit('::ffff:203.0.113.9', 'ip', 'otp_request')), true);
});

test('oversize identifiers are hashed into bounded keys', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  await svc.checkRateLimit(`${'a'.repeat(500_000)}@example.com`, 'email', 'otp_request');
  const keys = [...throttle.buckets.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].length < 200);
  assert.ok(keys[0].includes('sha256:'));
});

test('email buckets fold case and unicode normalisation', async () => {
  const throttle = memoryThrottle();
  const svc = new RateLimitService({} as any, throttle as any);
  await svc.checkRateLimit('Caf\u00e9@Example.com', 'email', 'otp_request');
  await svc.checkRateLimit('cafe\u0301@example.com ', 'email', 'otp_request');
  assert.equal(throttle.buckets.size, 1);
});

test('oversize email is rejected before any limiter or database work', async () => {
  const throttle = memoryThrottle();
  const rate = new RateLimitService({} as any, throttle as any);
  const otp = new OtpService(
    {
      otpCode: {
        updateMany: async () => {
          throw new Error('db touched');
        }
      }
    } as any,
    { isConfigured: () => true, sendOtpEmail: async () => true } as any,
    rate
  );
  await assert.rejects(
    otp.requestOtp(`${'a'.repeat(300)}@example.com`, '203.0.113.5'),
    (e: any) => e.getStatus?.() === 400
  );
  await assert.rejects(
    otp.verifyOtp(`${'a'.repeat(300)}@example.com`, '123456', '203.0.113.5'),
    (e: any) => e.getStatus?.() === 400
  );
  assert.equal(throttle.buckets.size, 0);
});

function otpHarness() {
  const throttle = memoryThrottle();
  const rate = new RateLimitService({} as any, throttle as any);
  const sent: string[] = [];
  const created: string[] = [];
  const otp = new OtpService(
    {
      otpCode: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: any) => {
          created.push(data.email);
          return {};
        }
      }
    } as any,
    {
      isConfigured: () => true,
      sendOtpEmail: async ({ recipientEmail }: any) => {
        sent.push(recipientEmail);
        return true;
      }
    } as any,
    rate
  );
  return { otp, throttle, sent, created };
}

test('an address without access gets the identical response and no mail', async () => {
  const { otp, sent, created } = otpHarness();
  const denied = await otp.requestOtp('stranger@example.com', '203.0.113.5', { deliver: false });
  const allowed = await otp.requestOtp('member@example.com', '203.0.113.5', { deliver: true });
  assert.deepEqual(denied, allowed);
  assert.deepEqual(sent, ['member@example.com']);
  assert.deepEqual(created, ['member@example.com']);
});

test('withheld sends still count against the per-address and per-ip send caps', async () => {
  const { otp, throttle } = otpHarness();
  await otp.requestOtp('stranger@example.com', '203.0.113.5', { deliver: false });
  assert.ok(throttle.buckets.has('otp_send:email:stranger@example.com'));
  assert.ok(throttle.buckets.has('otp_send:ip:203.0.113.5'));
  assert.equal(RATE_LIMIT_CONFIGS.otp_send_email.windowMs, 60 * 60 * 1000);
  assert.equal(RATE_LIMIT_CONFIGS.otp_send_ip.windowMs, 60 * 60 * 1000);
});
