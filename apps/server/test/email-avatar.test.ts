import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailAvatarService } from '../src/users/email-avatar.service';

// The whole point of this feature is that it never touches a picture someone
// chose themselves. That guarantee lives in two places — an early return in
// ensure(), and a conditional WHERE in the write — and both need to hold.

interface Row {
  id: string;
  email: string;
  imageUrl: string | null;
  imageSource: string | null;
  avatarCheckedAt: Date | null;
}

function makeService(row: Row, opts: { hit?: boolean; onWrite?: () => void } = {}) {
  const writes: any[] = [];
  const prisma: any = {
    user: {
      updateMany: async ({ where, data }: any) => {
        opts.onWrite?.();
        // Mirror the real null-safe OR guard against the current row.
        const allowed = where.OR.some((c: any) => c.imageSource === row.imageSource);
        if (!allowed) return { count: 0 };
        Object.assign(row, data);
        writes.push(data);
        return { count: 1 };
      },
    },
  };
  const svc = new EmailAvatarService(prisma);
  // Stand in for the network: pretend the address always has an avatar.
  (svc as any).fetchFrom = async () =>
    (opts.hit ?? true) ? { body: Buffer.from('x'), contentType: 'image/png' } : null;
  (svc as any).store = async () => 'https://cdn.example/imported.png';
  return { svc, writes, row };
}

test('a manual upload is never overwritten', async () => {
  const row: Row = {
    id: 'u1', email: 'a@example.com',
    imageUrl: 'https://cdn.example/mine.png', imageSource: 'upload', avatarCheckedAt: null,
  };
  const { svc, writes } = makeService(row);
  const result = await svc.ensure(row);
  assert.equal(result, 'https://cdn.example/mine.png');
  assert.equal(writes.length, 0, 'must not write at all for an upload');
  assert.equal(row.imageSource, 'upload');
});

test('a deleted picture is not resurrected', async () => {
  const row: Row = {
    id: 'u2', email: 'b@example.com',
    imageUrl: null, imageSource: 'none', avatarCheckedAt: null,
  };
  const { svc, writes } = makeService(row);
  assert.equal(await svc.ensure(row), null);
  assert.equal(writes.length, 0);
});

test('an unresolved user does get one imported', async () => {
  const row: Row = {
    id: 'u3', email: 'c@example.com',
    imageUrl: null, imageSource: null, avatarCheckedAt: null,
  };
  const { svc } = makeService(row);
  assert.equal(await svc.ensure(row), 'https://cdn.example/imported.png');
  assert.equal(row.imageSource, 'gravatar');
});

test('an upload landing mid-probe wins the race', async () => {
  // ensure() reads a row with no picture, then the user uploads one while the
  // fetch is in flight. The conditional write must lose, not clobber them.
  const row: Row = {
    id: 'u4', email: 'd@example.com',
    imageUrl: null, imageSource: null, avatarCheckedAt: null,
  };
  const snapshot = { ...row };
  const { svc } = makeService(row, {
    onWrite: () => {
      row.imageUrl = 'https://cdn.example/just-uploaded.png';
      row.imageSource = 'upload';
    },
  });
  const result = await svc.ensure(snapshot);
  assert.equal(result, null, 'import should report that it backed off');
  assert.equal(row.imageSource, 'upload');
  assert.equal(row.imageUrl, 'https://cdn.example/just-uploaded.png');
});

test('a recent check is not re-probed', async () => {
  const row: Row = {
    id: 'u5', email: 'e@example.com',
    imageUrl: null, imageSource: null, avatarCheckedAt: new Date(),
  };
  let probed = false;
  const { svc } = makeService(row);
  (svc as any).fetchFrom = async () => { probed = true; return null; };
  await svc.ensure(row);
  assert.equal(probed, false, 'inside the recheck window there should be no request');
});

test('a stale check is re-probed', async () => {
  const row: Row = {
    id: 'u6', email: 'f@example.com',
    imageUrl: null, imageSource: null,
    avatarCheckedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
  };
  const { svc } = makeService(row);
  assert.equal(await svc.ensure(row), 'https://cdn.example/imported.png');
});

test('the lookup can be switched off entirely', async () => {
  const saved = process.env.EMAIL_AVATAR_LOOKUP;
  process.env.EMAIL_AVATAR_LOOKUP = 'false';
  try {
    const row: Row = {
      id: 'u7', email: 'g@example.com',
      imageUrl: null, imageSource: null, avatarCheckedAt: null,
    };
    let probed = false;
    const { svc } = makeService(row);
    (svc as any).fetchFrom = async () => { probed = true; return null; };
    await svc.ensure(row);
    assert.equal(probed, false);
  } finally {
    if (saved === undefined) delete process.env.EMAIL_AVATAR_LOOKUP;
    else process.env.EMAIL_AVATAR_LOOKUP = saved;
  }
});
