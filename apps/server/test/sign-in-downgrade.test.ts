import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { OAuthController } from '../src/auth/oauth.controller';
import { PasswordlessController } from '../src/auth/passwordless.controller';

const USER = '11111111-1111-4111-8111-111111111111';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function prismaWith(session: { createdAt: Date; authMethod: string | null } | null) {
  return {
    session: { findFirst: async () => session },
    user: { findFirst: async () => ({ id: USER, email: 'a@x.dev', passwordHash: null }) }
  };
}

function oauth(session: { createdAt: Date; authMethod: string | null } | null) {
  const updates: unknown[] = [];
  const ctl = Object.create(OAuthController.prototype);
  Object.assign(ctl, {
    prisma: prismaWith(session),
    usersService: {
      findByIdOrExternalAuthId: async () => ({ id: USER, passkeyOnly: true }),
      updateProfile: async (_id: string, data: unknown) => {
        updates.push(data);
        return data;
      }
    }
  });
  return { ctl, updates };
}

function passwordless(session: { createdAt: Date; authMethod: string | null } | null) {
  const deleted: string[] = [];
  const ctl = Object.create(PasswordlessController.prototype);
  Object.assign(ctl, {
    prisma: prismaWith(session),
    passkeyService: { deletePasskey: async (_u: string, id: string) => deleted.push(id) }
  });
  return { ctl, deleted };
}

const req = (auth: Record<string, unknown>) => ({ user: { sub: USER }, auth });

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof HttpException);
    assert.equal(e.getStatus(), 403);
    return (e.getResponse() as any).code;
  }
  assert.fail('expected a refusal');
}

test('turning email codes back on needs a sign-in from the last ten minutes', async () => {
  const stale = oauth({ createdAt: minutesAgo(30), authMethod: 'passkey' });
  assert.equal(
    await refused(stale.ctl.updateMe(req({ sessionId: 's' }), { passkeyOnly: false })),
    'reauth_required'
  );
  assert.deepEqual(stale.updates, []);

  const fresh = oauth({ createdAt: minutesAgo(2), authMethod: 'passkey' });
  await fresh.ctl.updateMe(req({ sessionId: 's' }), { passkeyOnly: false });
  assert.equal(fresh.updates.length, 1);
});

test('an API token can never turn email codes back on', async () => {
  const w = oauth({ createdAt: minutesAgo(1), authMethod: 'passkey' });
  assert.equal(
    await refused(w.ctl.updateMe(req({ sessionId: 's', apiTokenId: 't' }), { passkeyOnly: false })),
    'reauth_required'
  );
  assert.deepEqual(w.updates, []);
});

test('turning email codes off and editing a name need no step-up', async () => {
  const w = oauth({ createdAt: minutesAgo(60), authMethod: 'otp' });
  await w.ctl.updateMe(req({ sessionId: 's' }), { passkeyOnly: true });
  await w.ctl.updateMe(req({ sessionId: 's' }), { firstName: 'Ada' });
  assert.equal(w.updates.length, 2);
});

test('removing a passkey needs a recent sign-in and is refused to tokens and MCP sessions', async () => {
  const stale = passwordless({ createdAt: minutesAgo(30), authMethod: 'passkey' });
  assert.equal(
    await refused(stale.ctl.deletePasskey('pk1', req({ sessionId: 's' }))),
    'reauth_required'
  );
  const token = passwordless({ createdAt: minutesAgo(1), authMethod: 'passkey' });
  assert.equal(
    await refused(token.ctl.deletePasskey('pk1', req({ sessionId: 's', apiTokenId: 't' }))),
    'reauth_required'
  );
  assert.deepEqual([...stale.deleted, ...token.deleted], []);

  const fresh = passwordless({ createdAt: minutesAgo(2), authMethod: 'passkey' });
  await fresh.ctl.deletePasskey('pk1', req({ sessionId: 's' }));
  assert.deepEqual(fresh.deleted, ['pk1']);
});
