import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { RateLimitService, RATE_LIMIT_CONFIGS } from '../src/auth/rate-limit.service';

const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://orchard:orchard@127.0.0.1:15432/orchard';

const TABLE = `
CREATE TABLE IF NOT EXISTS "rate_limit_records" (
  "id" UUID NOT NULL,
  "identifier" VARCHAR(255) NOT NULL,
  "type" VARCHAR(50) NOT NULL,
  "action" VARCHAR(50) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "window_start" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blocked_until" TIMESTAMP(6),
  CONSTRAINT "rate_limit_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "rate_limit_records_identifier_type_action_key"
  ON "rate_limit_records"("identifier", "type", "action");
`;

const offline = {
  available: false,
  retryAfter: async () => null,
  consume: async () => null,
  hit: async () => false,
  clear: async () => false
};

let client: PrismaClient | null = null;

async function db(): Promise<PrismaClient | null> {
  if (client) return client;
  const candidate = new PrismaClient({ datasourceUrl: URL });
  try {
    await candidate.$connect();
    for (const statement of TABLE.split(';').filter((s) => s.trim())) {
      await candidate.$executeRawUnsafe(statement);
    }
    client = candidate;
    return client;
  } catch {
    await candidate.$disconnect().catch(() => undefined);
    return null;
  }
}

function fresh(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function tooMany(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (e) {
    return e instanceof HttpException && e.getStatus() === 429;
  }
}

test('without redis, attempts are counted in postgres up to the limit and then refused', async (t) => {
  const prisma = await db();
  if (!prisma) return t.skip(`no test database at ${URL}`);
  const limiter = new RateLimitService(prisma, offline as any);
  const max = RATE_LIMIT_CONFIGS.otp_verify_email.maxAttempts;
  const who = fresh();
  for (let i = 0; i < max; i++) {
    await limiter.checkRateLimit(who, 'email', 'otp_verify');
  }
  assert.equal(await tooMany(limiter.checkRateLimit(who, 'email', 'otp_verify')), true);
});

test('a parallel burst cannot exceed the limit', async (t) => {
  const prisma = await db();
  if (!prisma) return t.skip(`no test database at ${URL}`);
  const limiter = new RateLimitService(prisma, offline as any);
  const max = RATE_LIMIT_CONFIGS.otp_verify_email.maxAttempts;
  const who = fresh();
  const results = await Promise.all(
    Array.from({ length: max * 10 }, () =>
      limiter.checkRateLimit(who, 'email', 'otp_verify').then(
        () => 'ok',
        (e) => (e instanceof HttpException && e.getStatus() === 429 ? 'refused' : 'error')
      )
    )
  );
  assert.equal(results.filter((r) => r === 'error').length, 0);
  assert.ok(results.filter((r) => r === 'ok').length <= max);
  assert.ok(results.filter((r) => r === 'refused').length >= max * 9);
});

test('a success hands the attempts back', async (t) => {
  const prisma = await db();
  if (!prisma) return t.skip(`no test database at ${URL}`);
  const limiter = new RateLimitService(prisma, offline as any);
  const max = RATE_LIMIT_CONFIGS.otp_verify_email.maxAttempts;
  const who = fresh();
  for (let i = 0; i < max; i++) {
    await limiter.checkRateLimit(who, 'email', 'otp_verify');
  }
  await limiter.resetRateLimit(who, 'email', 'otp_verify');
  await limiter.checkRateLimit(who, 'email', 'otp_verify');
});

test('an expired window starts over', async (t) => {
  const prisma = await db();
  if (!prisma) return t.skip(`no test database at ${URL}`);
  const limiter = new RateLimitService(prisma, offline as any);
  const config = RATE_LIMIT_CONFIGS.otp_verify_email;
  const who = fresh();
  for (let i = 0; i < config.maxAttempts; i++) {
    await limiter.checkRateLimit(who, 'email', 'otp_verify');
  }
  await prisma.rateLimitRecord.updateMany({
    where: { identifier: who, type: 'email', action: 'otp_verify' },
    data: { windowStart: new Date(Date.now() - config.windowMs - 1000), blockedUntil: null }
  });
  await limiter.checkRateLimit(who, 'email', 'otp_verify');
});

test.after(async () => {
  await client?.$disconnect();
});
