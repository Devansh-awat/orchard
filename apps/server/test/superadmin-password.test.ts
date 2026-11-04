import test from 'node:test';
import assert from 'node:assert/strict';
import * as bcrypt from 'bcrypt';
import {
  PasswordRefused,
  clearSuperadminPassword,
  setSuperadminPassword,
  superadminHasPassword,
  verifySuperadminPassword
} from '../src/auth/superadmin-password';
import { signedInUser } from '../src/auth/signed-in-user';

/**
 * The superadmin password exists for instances with no SMTP, no identity
 * provider and no TLS for passkeys. Everything here is about keeping that
 * narrow: superadmins only, set from the host, and no answer that tells an
 * unauthenticated caller which addresses exist.
 */

type Row = {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  passwordHash: string | null;
  createdAt: Date;
};

function prismaWith(rows: Row[]) {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        rows.find((r) => r.email === where.email || r.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        rows
          .filter((r) => (where?.isSuperAdmin ? r.isSuperAdmin : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        row.passwordHash = data.passwordHash;
        return row;
      }
    }
  } as any;
}

function superadmin(email = 'boss@example.com', hash: string | null = null): Row {
  return {
    id: 'u1',
    email,
    isSuperAdmin: true,
    passwordHash: hash,
    createdAt: new Date('2026-01-01')
  };
}

test('a password is stored hashed, never as typed', async () => {
  const row = superadmin();
  const prisma = prismaWith([row]);

  await setSuperadminPassword(prisma, '', 'correct horse battery staple');

  assert.ok(row.passwordHash);
  assert.notEqual(row.passwordHash, 'correct horse battery staple');
  assert.ok(row.passwordHash!.startsWith('$2'));
  assert.equal(await bcrypt.compare('correct horse battery staple', row.passwordHash!), true);
});

test('short passwords are refused', async () => {
  const prisma = prismaWith([superadmin()]);
  await assert.rejects(() => setSuperadminPassword(prisma, '', 'short'), PasswordRefused);
});

test('only a superadmin can have one', async () => {
  const ordinary: Row = {
    id: 'u2',
    email: 'dev@example.com',
    isSuperAdmin: false,
    passwordHash: null,
    createdAt: new Date('2026-01-02')
  };
  const prisma = prismaWith([superadmin(), ordinary]);

  await assert.rejects(
    () => setSuperadminPassword(prisma, 'dev@example.com', 'a long enough password'),
    PasswordRefused
  );
  assert.equal(ordinary.passwordHash, null);
});

test('with no email it takes the oldest superadmin', async () => {
  const older = superadmin('first@example.com');
  const newer = {
    ...superadmin('second@example.com'),
    id: 'u2',
    createdAt: new Date('2026-06-01')
  };
  const prisma = prismaWith([newer, older]);

  const who = await setSuperadminPassword(prisma, '', 'a long enough password');
  assert.equal(who, 'first@example.com');
});

test('the right password signs in, a wrong one does not', async () => {
  const row = superadmin();
  const prisma = prismaWith([row]);
  await setSuperadminPassword(prisma, '', 'a long enough password');

  assert.deepEqual(
    await verifySuperadminPassword(prisma, 'boss@example.com', 'a long enough password'),
    {
      id: 'u1',
      email: 'boss@example.com'
    }
  );
  assert.equal(await verifySuperadminPassword(prisma, 'boss@example.com', 'wrong'), null);
});

test('an address with no password, and an address with no account, answer the same', async () => {
  const prisma = prismaWith([superadmin()]);

  assert.equal(await verifySuperadminPassword(prisma, 'boss@example.com', 'anything'), null);
  assert.equal(await verifySuperadminPassword(prisma, 'nobody@example.com', 'anything'), null);
  assert.equal(await superadminHasPassword(prisma, 'nobody@example.com'), false);
});

test('a non-superadmin with a hash still cannot sign in with it', async () => {
  const sneaky: Row = {
    id: 'u3',
    email: 'dev@example.com',
    isSuperAdmin: false,
    passwordHash: await bcrypt.hash('a long enough password', 4),
    createdAt: new Date('2026-01-02')
  };
  const prisma = prismaWith([sneaky]);

  assert.equal(
    await verifySuperadminPassword(prisma, 'dev@example.com', 'a long enough password'),
    null
  );
  assert.equal(await superadminHasPassword(prisma, 'dev@example.com'), false);
});

test('clearing removes it', async () => {
  const row = superadmin();
  const prisma = prismaWith([row]);
  await setSuperadminPassword(prisma, '', 'a long enough password');
  assert.equal(await superadminHasPassword(prisma, 'boss@example.com'), true);

  await clearSuperadminPassword(prisma, '');
  assert.equal(row.passwordHash, null);
  assert.equal(await superadminHasPassword(prisma, 'boss@example.com'), false);
  assert.equal(
    await verifySuperadminPassword(prisma, 'boss@example.com', 'a long enough password'),
    null
  );
});

test('email case and whitespace do not matter', async () => {
  const prisma = prismaWith([superadmin()]);
  await setSuperadminPassword(prisma, '  BOSS@example.com ', 'a long enough password');
  assert.ok(
    await verifySuperadminPassword(prisma, '  Boss@Example.com  ', 'a long enough password')
  );
});

test('a sign-in response says superadmin only when it is true', () => {
  const base = {
    id: 'u1',
    email: 'a@b.c',
    username: 'a',
    firstName: null,
    lastName: null,
    imageUrl: null,
    setupCompleted: false
  };
  assert.equal(signedInUser({ ...base, isSuperAdmin: true }).isSuperAdmin, true);
  assert.equal('isSuperAdmin' in signedInUser({ ...base, isSuperAdmin: false }), false);
});
