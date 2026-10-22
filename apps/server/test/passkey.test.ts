import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { PasskeyService } from '../src/auth/passkey.service';
import {
  authenticator,
  passkeyUser,
  type Algorithm,
  type CeremonyOptions
} from './support/webauthn';

process.env.WEBAUTHN_ORIGIN = 'http://localhost:4000';
process.env.WEBAUTHN_RP_ID = 'localhost';

function harness() {
  const passkeys: any[] = [];
  const challenges: any[] = [];
  const rateChecks: unknown[][] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where).every(
      ([key, value]: [string, any]) =>
        value === undefined || (key === 'expiresAt' ? row[key] > value.gt : row[key] === value)
    );
  const remove = (rows: any[], where: any) => {
    const found = rows.filter((row) => matches(row, where));
    for (const row of found) rows.splice(rows.indexOf(row), 1);
    return { count: found.length };
  };
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) =>
        where.email === passkeyUser.email ? { ...passkeyUser, passkeys } : null
    },
    passkey: {
      findMany: async () => passkeys,
      findUnique: async ({ where }: any) => {
        const row = passkeys.find((row) => matches(row, where));
        return row ? { ...row, user: passkeyUser } : null;
      },
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), ...data };
        passkeys.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const found = passkeys.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }
    },
    webAuthnChallenge: {
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), ...data };
        challenges.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => challenges.find((row) => matches(row, where)) ?? null,
      deleteMany: async ({ where }: any) => remove(challenges, where)
    }
  };
  prisma.$transaction = async (run: (tx: any) => Promise<unknown>) => run(prisma);
  const rateLimit: any = {
    checkRateLimit: async (...args: unknown[]) => {
      rateChecks.push(args);
    },
    resetRateLimit: async () => {}
  };
  const service = new PasskeyService(prisma, rateLimit);
  async function register(
    key = authenticator(),
    options: CeremonyOptions & { attestation?: 'none' | 'packed' } = {}
  ) {
    const challenge = await service.generateRegistrationOptions(passkeyUser.id, passkeyUser.email);
    const result = await service.verifyRegistration(
      passkeyUser.id,
      passkeyUser.email,
      key.registration(challenge.challenge, options)
    );
    assert.equal(result.verified, true);
    return key;
  }
  async function response(
    key: ReturnType<typeof authenticator>,
    options: CeremonyOptions = {},
    email: string | undefined = passkeyUser.email
  ) {
    const challenge = await service.generateAuthenticationOptions(email, '127.0.0.1');
    return key.authentication(challenge.challenge, options);
  }
  return { service, passkeys, challenges, rateChecks, register, response };
}

for (const algorithm of ['ES256', 'RS256', 'Ed25519'] as Algorithm[]) {
  for (const attestation of ['none', 'packed'] as const) {
    test(`${algorithm} ${attestation} registration survives database encoding and signs in`, async () => {
      const h = harness();
      const key = await h.register(authenticator(algorithm), { attestation });
      assert.equal(typeof h.passkeys[0].publicKey, 'string');
      assert.deepEqual(
        await h.service.verifyAuthentication(await h.response(key, { counter: 1 }), '127.0.0.1'),
        { verified: true, userId: passkeyUser.id, email: passkeyUser.email }
      );
      assert.equal(h.passkeys[0].counter, 1n);
      assert.ok(h.passkeys[0].lastUsedAt instanceof Date);
      assert.equal(h.challenges.length, 0);
    });
  }
}

test('registration allows platform, roaming and hybrid authenticators', async () => {
  const { service } = harness();
  const options = await service.generateRegistrationOptions(passkeyUser.id, passkeyUser.email);
  assert.equal(options.authenticatorSelection?.authenticatorAttachment, undefined);
  assert.equal(options.authenticatorSelection?.residentKey, 'preferred');
  assert.equal(options.authenticatorSelection?.userVerification, 'preferred');
  assert.deepEqual(
    options.pubKeyCredParams.map((p) => p.alg).sort((a, b) => a - b),
    [-257, -8, -7]
  );
});

test('synced passkeys with a constant zero counter can sign in repeatedly', async () => {
  const h = harness();
  const flags = { backupEligible: true, backedUp: true, counter: 0 };
  const key = await h.register(authenticator(), flags);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await h.service.verifyAuthentication(await h.response(key, flags), '127.0.0.1')).verified,
      true
    );
  assert.equal(h.passkeys[0].counter, 0n);
});

test('security keys allow no user verification or handle and enforce increasing counters', async () => {
  const h = harness();
  const key = await h.register(authenticator(), { userVerified: false });
  const response = await h.response(key, { userVerified: false, counter: 1 });
  delete response.response.userHandle;
  assert.equal((await h.service.verifyAuthentication(response, '127.0.0.1')).verified, true);
  await assert.rejects(
    h.service.verifyAuthentication(await h.response(key, { counter: 1 }), '127.0.0.1'),
    BadRequestException
  );
});

test('backup state is refreshed after a synced credential is backed up', async () => {
  const h = harness();
  const key = await h.register(authenticator(), { backupEligible: true });
  await h.service.verifyAuthentication(
    await h.response(key, { backupEligible: true, backedUp: true }),
    '127.0.0.1'
  );
  assert.equal(h.passkeys[0].backedUp, true);
});

for (const [name, options] of [
  ['changed backup eligibility', { backupEligible: true }],
  ['wrong user handle', { userHandle: Buffer.from('another-user').toString('base64url') }]
] as [string, CeremonyOptions][]) {
  test(`authentication rejects ${name}`, async () => {
    const h = harness();
    const key = await h.register();
    await assert.rejects(
      h.service.verifyAuthentication(await h.response(key, options), '127.0.0.1'),
      BadRequestException
    );
    assert.equal(h.passkeys[0].lastUsedAt, undefined);
  });
}

test('a corrupted signature cannot sign in or advance the counter', async () => {
  const h = harness();
  const key = await h.register();
  const response = await h.response(key, { counter: 1 });
  const sig = Buffer.from(response.response.signature, 'base64url');
  sig[sig.length - 1] ^= 1;
  response.response.signature = sig.toString('base64url');
  await assert.rejects(h.service.verifyAuthentication(response, '127.0.0.1'), BadRequestException);
  assert.equal(h.passkeys[0].counter, 0n);
});

test('email-bound authentication cannot sign in a different account', async () => {
  const h = harness();
  const key = await h.register();
  await assert.rejects(
    h.service.verifyAuthentication(
      await h.response(key, {}, 'someone-else@example.test'),
      '127.0.0.1'
    ),
    BadRequestException
  );
});

test('discoverable authentication can omit the email and is rate limited by IP', async () => {
  const h = harness();
  const key = await h.register();
  const options = await h.service.generateAuthenticationOptions(undefined, '127.0.0.1');
  assert.ok(h.rateChecks.some((args) => args[0] === '127.0.0.1' && args[1] === 'ip'));
  assert.equal(
    (await h.service.verifyAuthentication(key.authentication(options.challenge), '127.0.0.1'))
      .verified,
    true
  );
});

test('expired challenges and sequential assertion replays are rejected', async () => {
  const h = harness();
  const key = await h.register();
  const expired = await h.response(key);
  h.challenges[0].expiresAt = new Date(0);
  await assert.rejects(h.service.verifyAuthentication(expired, '127.0.0.1'), BadRequestException);
  const valid = await h.response(key);
  await h.service.verifyAuthentication(valid, '127.0.0.1');
  await assert.rejects(h.service.verifyAuthentication(valid, '127.0.0.1'), BadRequestException);
});

test('concurrent assertion replay has one success and one controlled rejection', async () => {
  const h = harness();
  const key = await h.register();
  const response = await h.response(key);
  const results = await Promise.allSettled([
    h.service.verifyAuthentication(response, '127.0.0.1'),
    h.service.verifyAuthentication(response, '127.0.0.1')
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof BadRequestException);
});

for (const clientDataJSON of [
  '',
  Buffer.from('not json').toString('base64url'),
  Buffer.from('null').toString('base64url'),
  Buffer.from('{}').toString('base64url')
]) {
  test(`malformed client data returns a bad request: ${clientDataJSON}`, async () => {
    const h = harness();
    const key = await h.register();
    const response = await h.response(key);
    response.response.clientDataJSON = clientDataJSON;
    await assert.rejects(
      h.service.verifyAuthentication(response, '127.0.0.1'),
      BadRequestException
    );
  });
}

test('registration challenges are bound to the initiating user as well as the email', async () => {
  const h = harness();
  const options = await h.service.generateRegistrationOptions('another-user', passkeyUser.email);
  await assert.rejects(
    h.service.verifyRegistration(
      passkeyUser.id,
      passkeyUser.email,
      authenticator().registration(options.challenge)
    ),
    BadRequestException
  );
});

test('registration excludes existing credentials and preserves transport hints', async () => {
  const h = harness();
  const key = await h.register();
  const options = await h.service.generateRegistrationOptions(passkeyUser.id, passkeyUser.email);
  assert.deepEqual(options.excludeCredentials, [
    { id: key.id, type: 'public-key', transports: ['internal', 'hybrid'] }
  ]);
  const authentication = await h.service.generateAuthenticationOptions(
    '  PASSKEY@EXAMPLE.TEST  ',
    '127.0.0.1'
  );
  assert.deepEqual(authentication.allowCredentials, options.excludeCredentials);
  assert.equal(h.challenges.at(-1).email, passkeyUser.email);
});

for (const value of [undefined, null, {}, { response: {} }]) {
  test(`missing credential fields return a bad request: ${JSON.stringify(value)}`, async () => {
    const h = harness();
    await assert.rejects(
      h.service.verifyAuthentication(value as any, '127.0.0.1'),
      BadRequestException
    );
    await assert.rejects(
      h.service.verifyRegistration(passkeyUser.id, passkeyUser.email, value as any),
      BadRequestException
    );
  });
}
