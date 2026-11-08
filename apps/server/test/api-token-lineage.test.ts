import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiTokensService,
  MAX_ACTIVE_TOKENS_PER_USER,
  hashApiToken
} from '../src/auth/api-tokens.service';

const DAY = 24 * 60 * 60 * 1000;
const PARENT = '11111111-1111-4111-8111-111111111111';

type Row = {
  id: string;
  tokenHash: string;
  expiresAt: Date | null;
  userId: string;
  scopes: string[];
  parentTokenId?: string | null;
};

function store() {
  const rows = new Map<string, Row>();
  const prisma: any = {
    apiToken: {
      create: async ({ data }: any) => {
        const row = { id: `new-${rows.size}`, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      count: async ({ where }: any) =>
        [...rows.values()].filter(
          (r) => r.userId === where.userId && (!r.expiresAt || r.expiresAt.getTime() > Date.now())
        ).length,
      findUnique: async ({ where }: any) => {
        if (where.id) return rows.get(where.id) ?? null;
        return [...rows.values()].find((r) => r.tokenHash === where.tokenHash) ?? null;
      }
    }
  };
  return { rows, prisma };
}

function service(prisma: any) {
  return new ApiTokensService(prisma, { log: async () => {} } as any, {} as any);
}

const ceiling = (tokenId = PARENT) => ({
  scopes: ['read', 'deploy', 'exec'],
  projectIds: [],
  tokenId
});

function root(rows: Map<string, Row>, id: string, expiresAt: Date | null = null, parent?: string) {
  rows.set(id, {
    id,
    tokenHash: `h-${id}`,
    expiresAt,
    userId: 'u',
    scopes: [],
    parentTokenId: parent ?? null
  });
}

test('a minted token never outlives its parent', async () => {
  const { rows, prisma } = store();
  const parentExpiry = new Date(Date.now() + 2 * DAY);
  root(rows, PARENT, parentExpiry);
  const svc = service(prisma);

  const defaulted = await svc.create('u', 'child', undefined, ['read'], undefined, ceiling());
  assert.equal(defaulted.expiresAt!.getTime(), parentExpiry.getTime());

  const later = await svc.create(
    'u',
    'child',
    new Date(Date.now() + 30 * DAY),
    ['read'],
    undefined,
    ceiling()
  );
  assert.equal(later.expiresAt!.getTime(), parentExpiry.getTime());

  const sooner = new Date(Date.now() + DAY);
  const shorter = await svc.create('u', 'child', sooner, ['read'], undefined, ceiling());
  assert.equal(shorter.expiresAt!.getTime(), sooner.getTime());
});

test('a gone or expired parent cannot mint', async () => {
  const { rows, prisma } = store();
  const svc = service(prisma);
  await assert.rejects(() => svc.create('u', 'c', undefined, ['read'], undefined, ceiling()));
  root(rows, PARENT, new Date(Date.now() - 1000));
  await assert.rejects(() => svc.create('u', 'c', undefined, ['read'], undefined, ceiling()));
});

test('a minted token records its parent and keeps a plain plaintext format', async () => {
  const { rows, prisma } = store();
  root(rows, PARENT);
  const svc = service(prisma);
  const child = await svc.create('u', 'c', undefined, ['read'], undefined, ceiling());
  assert.match(child.token, /^orch_[0-9a-f]{64}$/);
  const stored = [...rows.values()].find((r) => r.tokenHash === hashApiToken(child.token));
  assert.ok(stored);
  assert.equal(stored.parentTokenId, PARENT);

  const top = await svc.create('u', 'root', undefined, ['read']);
  assert.match(top.token, /^orch_[0-9a-f]{64}$/);
  const topRow = [...rows.values()].find((r) => r.tokenHash === hashApiToken(top.token));
  assert.equal(topRow!.parentTokenId, undefined);
});

test('minting is refused once the chain is eight deep', async () => {
  const { rows, prisma } = store();
  const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
  ids.forEach((id, i) => root(rows, id, null, i === 0 ? undefined : ids[i - 1]));
  const svc = service(prisma);
  await svc.create('u', 'ok', undefined, ['read'], undefined, ceiling('t7'));
  await assert.rejects(
    () => svc.create('u', 'too deep', undefined, ['read'], undefined, ceiling('t8')),
    /too many mints deep/
  );
  await assert.rejects(
    () => svc.create('u', 'too deep', undefined, ['read'], undefined, ceiling('t9')),
    /too many mints deep/
  );
});

test('an ancestor that is gone or expired blocks minting from a descendant', async () => {
  const { rows, prisma } = store();
  root(rows, 'a');
  root(rows, 'b', null, 'a');
  const svc = service(prisma);
  await svc.create('u', 'ok', undefined, ['read'], undefined, ceiling('b'));
  rows.get('a')!.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(() => svc.create('u', 'c', undefined, ['read'], undefined, ceiling('b')));
});

test('a user cannot hold more than the cap of active tokens', async () => {
  const { rows, prisma } = store();
  for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i++) {
    root(rows, `t${i}`, new Date(Date.now() + DAY));
  }
  const svc = service(prisma);
  await assert.rejects(svc.create('u', 'one more'), /at most/);
  rows.delete('t0');
  await svc.create('u', 'fits now');
});
