import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { OtpService } from '../src/auth/otp.service';

function service(configured: boolean) {
  const sent: string[] = [];
  const prisma = {
    otpCode: { updateMany: async () => ({ count: 0 }), create: async () => ({}) }
  };
  const email = {
    isConfigured: () => configured,
    sendOtpEmail: async (data: { recipientEmail: string }) => {
      sent.push(data.recipientEmail);
      return configured;
    }
  };
  const rateLimit = {
    checkRateLimit: async () => undefined,
    checkRateLimits: async () => ({ pressured: false }),
    slowDown: async () => undefined
  };
  return { otp: new OtpService(prisma as any, email as any, rateLimit as any), sent };
}

async function inProduction(fn: () => Promise<void>) {
  const previous = process.env.NODE_ENV;
  const previousSecret = process.env.JWT_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret';
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
}

test('without SMTP in production no code is offered or minted', async () => {
  await inProduction(async () => {
    const { otp, sent } = service(false);
    assert.equal(otp.canDeliverCodes(), false);
    await assert.rejects(otp.requestOtp('a@example.com', '1.1.1.1'), ServiceUnavailableException);
    assert.deepEqual(sent, []);
  });
});

test('with SMTP a code is sent as before', async () => {
  await inProduction(async () => {
    const { otp, sent } = service(true);
    assert.equal(otp.canDeliverCodes(), true);
    const result = await otp.requestOtp('a@example.com', '1.1.1.1');
    assert.equal(result.success, true);
    assert.deepEqual(sent, ['a@example.com']);
  });
});

test('outside production the code still reaches the dev log', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    assert.equal(service(false).otp.canDeliverCodes(), true);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
