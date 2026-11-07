import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtpService } from '../src/auth/otp.service';
import { UsersService } from '../src/users/users.service';
import { hashOtpCode } from '../src/auth/otp-code';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeDb(email: string, emailVerified: boolean) {
  const state = {
    user: {
      id: 'u1',
      email,
      emailVerified,
      emailVerifiedAt: null as Date | null,
      externalAuthId: null as string | null,
      passwordHash: 'admin-chosen-hash' as string | null,
      githubId: 'gh-1' as string | null,
      githubUsername: 'planted' as string | null,
      githubAccessToken: 'tok' as string | null,
      githubTokenExpiresAt: null,
      githubRefreshToken: null,
      githubRefreshTokenExpiresAt: null
    },
    sessions: [
      { id: 's1', userId: 'u1', authMethod: 'password', revokedAt: null as Date | null },
      { id: 's2', userId: 'u1', authMethod: 'passkey', revokedAt: null as Date | null }
    ],
    passkeys: [{ id: 'p1', userId: 'u1' }],
    apiTokens: [{ id: 't1', userId: 'u1' }],
    gitConnections: [{ id: 'g1', userId: 'u1' }],
    installs: [{ id: 'i1', userId: 'u1' }]
  };
  const drop =
    (rows: any[]) =>
    async ({ where }: any) => {
      for (let i = rows.length - 1; i >= 0; i -= 1)
        if (rows[i].userId === where.userId) rows.splice(i, 1);
    };
  const db: any = {
    user: {
      findUnique: async ({ where }: any) =>
        where.email === state.user.email || where.id === state.user.id ? state.user : null,
      update: async ({ data }: any) => Object.assign(state.user, data)
    },
    session: {
      updateMany: async ({ where, data }: any) => {
        for (const s of state.sessions) {
          if (s.userId === where.userId && s.revokedAt === null) Object.assign(s, data);
        }
      }
    },
    passkey: { deleteMany: drop(state.passkeys) },
    apiToken: { deleteMany: drop(state.apiTokens) },
    gitConnection: { deleteMany: drop(state.gitConnections) },
    gitHubAppInstallation: { deleteMany: drop(state.installs) },
    otpCode: {
      findFirst: async () => ({ id: 'o1', code: hashOtpCode('123456') }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({})
    }
  };
  db.$transaction = async (fn: any) => fn(db);
  return { db, state };
}

function assertWiped(state: ReturnType<typeof makeDb>['state']) {
  assert.equal(state.user.passwordHash, null);
  assert.equal(state.user.githubId, null);
  assert.equal(state.user.githubAccessToken, null);
  assert.ok(state.sessions.every((s) => s.revokedAt !== null));
  assert.equal(state.passkeys.length, 0);
  assert.equal(state.apiTokens.length, 0);
  assert.equal(state.gitConnections.length, 0);
  assert.equal(state.installs.length, 0);
  assert.equal(state.user.emailVerified, true);
}

test('OAuth sign-in adopting an unverified row discards every prior credential', async () => {
  const { db, state } = makeDb('victim@example.com', false);
  const users = new UsersService(
    db,
    { log: async () => {} } as any,
    {
      ensureImageUrl: async () => {}
    } as any
  );
  (users as any).ensureImageUrl = async () => {};
  const found = await users.findOrCreateByExternalAuthId({
    id: 'ext-1',
    email: 'victim@example.com',
    name: 'Victim'
  });
  assert.equal(found.externalAuthId, 'ext-1');
  assertWiped(state);
});

test('OAuth sign-in on an already verified row keeps its credentials', async () => {
  const { db, state } = makeDb('victim@example.com', true);
  const users = new UsersService(db, { log: async () => {} } as any, {} as any);
  (users as any).ensureImageUrl = async () => {};
  await users.findOrCreateByExternalAuthId({ id: 'ext-1', email: 'victim@example.com', name: 'V' });
  assert.equal(state.user.passwordHash, 'admin-chosen-hash');
  assert.equal(state.passkeys.length, 1);
  assert.ok(state.sessions.every((s) => s.revokedAt === null));
});

test('OTP verification of an unverified row discards every prior credential', async () => {
  const { db, state } = makeDb('victim@example.com', false);
  const otp = new OtpService(
    db,
    {} as any,
    {
      checkRateLimit: async () => {},
      resetRateLimit: async () => {}
    } as any
  );
  const result = await otp.verifyOtp('victim@example.com', '123456', '1.1.1.1');
  assert.equal(result.valid, true);
  assertWiped(state);
});

test('OTP verification of a verified row leaves credentials alone', async () => {
  const { db, state } = makeDb('victim@example.com', true);
  const otp = new OtpService(
    db,
    {} as any,
    {
      checkRateLimit: async () => {},
      resetRateLimit: async () => {}
    } as any
  );
  await otp.verifyOtp('victim@example.com', '123456', '1.1.1.1');
  assert.equal(state.user.passwordHash, 'admin-chosen-hash');
  assert.equal(state.apiTokens.length, 1);
});
