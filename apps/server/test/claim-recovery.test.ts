import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryState } from '../src/setup/setup-token';

function prismaWith(
  opts: {
    superadmins?: number;
    passkeys?: number;
    passwords?: number;
    emailRow?: string | null;
  } = {}
) {
  const seen: { passkeyWhere?: any } = {};
  const prisma = {
    user: {
      // Two different counts go through here: how many superadmins exist, and
      // how many of them have a password. A fake that ignores its arguments
      // answers the second with the first and reports a password nobody set.
      count: async (args: any) =>
        args?.where?.passwordHash ? (opts.passwords ?? 0) : (opts.superadmins ?? 0)
    },
    passkey: {
      count: async (args: any) => {
        seen.passkeyWhere = args?.where;
        return opts.passkeys ?? 0;
      }
    },
    instanceSetting: {
      findUnique: async () => (opts.emailRow == null ? null : { value: opts.emailRow })
    }
  };
  return { prisma: prisma as any, seen };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const CLEAR = {
  SMTP_HOST: undefined,
  AUTH_OAUTH_CLIENT_ID: undefined,
  AUTH_OAUTH_CLIENT_SECRET: undefined,
  HACKCLUB_CLIENT_ID: undefined,
  HACKCLUB_CLIENT_SECRET: undefined
};

test('a fresh instance is claimable', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 0 });
    const state = await recoveryState(prisma);
    assert.equal(state.claimable, true);
    assert.equal(state.blockedBy, null);
  });
});

// The reported lockout: claimed, passkey skipped, cookies cleared, no SMTP.
// Refusing here leaves the operator locked out of their own machine.
test('a superadmin password is a way back in, so it closes the window', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 1, passkeys: 0, passwords: 1 });
    const state = await recoveryState(prisma);
    assert.equal(state.password, true);
    assert.equal(state.claimable, false);
    assert.equal(state.blockedBy, 'password');
  });
});

test('a superadmin with no way back in can mint a recovery link', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 1, passkeys: 0 });
    const state = await recoveryState(prisma);
    assert.equal(state.claimable, true);
    assert.equal(state.blockedBy, null);
  });
});

test('a passkey on a superadmin blocks it', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 1, passkeys: 1 });
    const state = await recoveryState(prisma);
    assert.equal(state.claimable, false);
    assert.equal(state.blockedBy, 'passkey');
  });
});

// A passkey on an ordinary user is not a way into the superadmin account.
test('only a superadmin passkey counts', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma, seen } = prismaWith({ superadmins: 1, passkeys: 0 });
    await recoveryState(prisma);
    assert.deepEqual(seen.passkeyWhere, { user: { isSuperAdmin: true } });
  });
});

test('SMTP from the environment blocks it', async () => {
  await withEnv({ ...CLEAR, SMTP_HOST: 'smtp.example.com' }, async () => {
    const { prisma } = prismaWith({ superadmins: 1 });
    const state = await recoveryState(prisma);
    assert.equal(state.claimable, false);
    assert.equal(state.blockedBy, 'smtp');
  });
});

test('SMTP stored in the admin panel blocks it too', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({
      superadmins: 1,
      emailRow: JSON.stringify({ host: 'smtp.example.com' })
    });
    const state = await recoveryState(prisma);
    assert.equal(state.blockedBy, 'smtp');
  });
});

test('an email row with no host is not a way in', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 1, emailRow: JSON.stringify({ from: 'a@b.c' }) });
    assert.equal((await recoveryState(prisma)).claimable, true);
  });
});

// A corrupt row must not throw here: this runs on every boot, and throwing
// would take out the claim sweep entirely.
test('an unparseable email row is treated as unconfigured', async () => {
  await withEnv(CLEAR, async () => {
    const { prisma } = prismaWith({ superadmins: 1, emailRow: 'not json' });
    assert.equal((await recoveryState(prisma)).claimable, true);
  });
});

test('an identity provider blocks it', async () => {
  await withEnv(
    { ...CLEAR, AUTH_OAUTH_CLIENT_ID: 'id', AUTH_OAUTH_CLIENT_SECRET: 'secret' },
    async () => {
      const { prisma } = prismaWith({ superadmins: 1 });
      assert.equal((await recoveryState(prisma)).blockedBy, 'oauth');
    }
  );
});

test('half-configured OAuth is not a way in', async () => {
  await withEnv({ ...CLEAR, AUTH_OAUTH_CLIENT_ID: 'id' }, async () => {
    const { prisma } = prismaWith({ superadmins: 1 });
    assert.equal((await recoveryState(prisma)).claimable, true);
  });
});

test('the passkey is named first when several ways in exist', async () => {
  await withEnv({ ...CLEAR, SMTP_HOST: 'smtp.example.com' }, async () => {
    const { prisma } = prismaWith({ superadmins: 1, passkeys: 2 });
    assert.equal((await recoveryState(prisma)).blockedBy, 'passkey');
  });
});

// The sweep on boot deletes the token whenever this is false, so a fresh
// instance must never report blocked before anyone has claimed it.
test('a fresh instance never reports a blocker', async () => {
  await withEnv({ ...CLEAR, SMTP_HOST: 'smtp.example.com' }, async () => {
    const { prisma } = prismaWith({ superadmins: 0, passkeys: 5 });
    const state = await recoveryState(prisma);
    assert.equal(state.claimable, true);
    assert.equal(state.blockedBy, null);
  });
});
