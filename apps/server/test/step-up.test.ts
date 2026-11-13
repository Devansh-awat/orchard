import test from 'node:test';
import assert from 'node:assert/strict';
import * as bcrypt from 'bcrypt';
import { HttpException } from '@nestjs/common';
import { PasswordlessController } from '../src/auth/passwordless.controller';
import { RECENT_SIGN_IN_MS } from '../src/auth/step-up';

const MINUTE = 60 * 1000;

async function build(opts: {
  passwordHash?: string | null;
  sessionAgeMs?: number | null;
  sessionAuthMethod?: string | null;
  isSuperAdmin?: boolean;
}) {
  const user = {
    id: 'user-1',
    email: 'owner@example.com',
    isSuperAdmin: opts.isSuperAdmin ?? false,
    passwordHash: opts.passwordHash ?? null
  };
  const writes: unknown[] = [];
  const passkeys: unknown[] = [];
  const revoked: unknown[] = [];
  const limited: unknown[] = [];
  const prisma: any = {
    user: {
      findFirst: async () => user,
      findUnique: async () => user,
      update: async (args: unknown) => writes.push(args)
    },
    session: {
      findFirst: async (args: any) => {
        if (opts.sessionAgeMs === null || opts.sessionAgeMs === undefined) return null;
        assert.equal(args.where.id, 'session-1');
        assert.equal(args.where.userId, user.id);
        return {
          createdAt: new Date(Date.now() - opts.sessionAgeMs),
          authMethod: opts.sessionAuthMethod ?? 'otp'
        };
      }
    }
  };
  const controller = Object.assign(Object.create(PasswordlessController.prototype), {
    prisma,
    otpService: { sendsEmail: () => false },
    sessionsService: {
      revokeAllSessions: async (...args: unknown[]) => revoked.push(args)
    },
    rateLimit: {
      checkRateLimit: async (...args: unknown[]) => limited.push(args)
    },
    audit: { log: async () => {} },
    passkeyService: {
      generateRegistrationOptions: async () => ({ challenge: 'c' }),
      verifyRegistration: async (...args: unknown[]) => {
        passkeys.push(args);
        return { verified: true };
      }
    }
  }) as PasswordlessController;
  const req = (auth: Record<string, unknown>) => ({
    user: { sub: user.id, email: user.email },
    auth: { sessionId: 'session-1', ...auth }
  });
  const call = (body: Record<string, unknown>, auth: Record<string, unknown> = {}) =>
    controller.setOwnPassword(body as any, req(auth));
  const passkeyOptions = (body: Record<string, unknown>, auth: Record<string, unknown> = {}) =>
    controller.getRegistrationOptions(body as any, req(auth));
  const passkeyVerify = (body: Record<string, unknown>, auth: Record<string, unknown> = {}) =>
    controller.verifyRegistration({ response: {}, ...body } as any, req(auth));
  return { call, passkeyOptions, passkeyVerify, writes, passkeys, revoked, limited };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpException);
    return { status: err.getStatus(), code: (err.getResponse() as any).code };
  }
  assert.fail('expected the request to be refused');
}

const NEW_PASSWORD = 'a brand new passphrase';

test('a stale session without a password cannot set one', async () => {
  const { call, writes, revoked } = await build({ sessionAgeMs: RECENT_SIGN_IN_MS + MINUTE });
  assert.deepEqual(await refusal(call({ password: NEW_PASSWORD })), {
    status: 403,
    code: 'reauth_required'
  });
  assert.equal(writes.length, 0);
  assert.equal(revoked.length, 0);
});

test('a fresh sign-in can set a first password', async () => {
  const { call, writes, revoked } = await build({ sessionAgeMs: 2 * MINUTE });
  assert.deepEqual(await call({ password: NEW_PASSWORD }), { success: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(revoked, [['user-1', 'session-1']]);
});

test('an API token or MCP session never counts as a recent sign-in', async () => {
  const token = await build({ sessionAgeMs: MINUTE });
  assert.equal(
    (await refusal(token.call({ password: NEW_PASSWORD }, { apiTokenId: 't' }))).code,
    'reauth_required'
  );
  const noSession = await build({ sessionAgeMs: MINUTE });
  assert.equal(
    (await refusal(noSession.call({ password: NEW_PASSWORD }, { sessionId: undefined }))).code,
    'reauth_required'
  );
  const mcp = await build({ sessionAgeMs: MINUTE, sessionAuthMethod: 'mcp' });
  assert.equal((await refusal(mcp.call({ password: NEW_PASSWORD }))).code, 'reauth_required');
  const revokedSession = await build({ sessionAgeMs: null });
  assert.equal(
    (await refusal(revokedSession.call({ password: NEW_PASSWORD }))).code,
    'reauth_required'
  );
  for (const b of [token, noSession, mcp, revokedSession]) assert.equal(b.writes.length, 0);
});

test('changing an existing password needs the current one, even on a fresh session', async () => {
  const passwordHash = await bcrypt.hash('the old passphrase', 4);
  const { call, writes, revoked, limited } = await build({ passwordHash, sessionAgeMs: MINUTE });

  assert.deepEqual(await refusal(call({ password: NEW_PASSWORD })), {
    status: 403,
    code: 'current_password_required'
  });
  assert.deepEqual(
    await refusal(call({ password: NEW_PASSWORD, currentPassword: 'a wrong guess' })),
    { status: 403, code: 'current_password_incorrect' }
  );
  assert.equal(writes.length, 0);
  assert.equal(revoked.length, 0);
  assert.ok(limited.length >= 2, 'current-password guesses are rate limited');

  assert.deepEqual(await call({ password: NEW_PASSWORD, currentPassword: 'the old passphrase' }), {
    success: true
  });
  assert.equal(writes.length, 1);
});

test('the current password is enough on a stale session', async () => {
  const passwordHash = await bcrypt.hash('the old passphrase', 4);
  const { call, writes } = await build({
    passwordHash,
    sessionAgeMs: 30 * 24 * 60 * MINUTE,
    isSuperAdmin: true
  });
  await call({ password: NEW_PASSWORD, currentPassword: 'the old passphrase' });
  assert.equal(writes.length, 1);
});

test('a stale session without a password cannot add a passkey', async () => {
  const { passkeyOptions, passkeyVerify, passkeys, revoked } = await build({
    sessionAgeMs: RECENT_SIGN_IN_MS + MINUTE
  });
  assert.deepEqual(await refusal(passkeyOptions({})), { status: 403, code: 'reauth_required' });
  assert.deepEqual(await refusal(passkeyVerify({})), { status: 403, code: 'reauth_required' });
  assert.equal(passkeys.length, 0);
  assert.equal(revoked.length, 0);
});

test('a stolen token or MCP session cannot add a passkey', async () => {
  const token = await build({ sessionAgeMs: MINUTE });
  assert.equal(
    (await refusal(token.passkeyVerify({}, { apiTokenId: 't' }))).code,
    'reauth_required'
  );
  const mcp = await build({ sessionAgeMs: MINUTE, sessionAuthMethod: 'mcp' });
  assert.equal((await refusal(mcp.passkeyVerify({}))).code, 'reauth_required');
  assert.equal(token.passkeys.length + mcp.passkeys.length, 0);
});

test('a fresh sign-in, as in setup and invite sign-up, can add a passkey', async () => {
  const { passkeyOptions, passkeyVerify, passkeys, revoked } = await build({
    sessionAgeMs: MINUTE
  });
  assert.deepEqual(await passkeyOptions({}), { challenge: 'c' });
  assert.deepEqual(await passkeyVerify({ friendlyName: 'Laptop' }), { verified: true });
  assert.equal(passkeys.length, 1);
  assert.deepEqual(revoked, [['user-1', 'session-1']]);
});

test('adding a passkey to an account with a password needs that password', async () => {
  const passwordHash = await bcrypt.hash('the old passphrase', 4);
  const { passkeyOptions, passkeyVerify, passkeys } = await build({
    passwordHash,
    sessionAgeMs: MINUTE
  });
  assert.equal((await refusal(passkeyOptions({}))).code, 'current_password_required');
  assert.equal(
    (await refusal(passkeyVerify({ currentPassword: 'a wrong guess' }))).code,
    'current_password_incorrect'
  );
  assert.equal(passkeys.length, 0);
  await passkeyOptions({ currentPassword: 'the old passphrase' });
  await passkeyVerify({ currentPassword: 'the old passphrase' });
  assert.equal(passkeys.length, 1);
});
