import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SandboxLimitsController,
  pageOf,
  parseMaxSandboxes
} from '../server/src/admin/sandbox-limits.controller';
import { SandboxesService, defaultMaxSandboxes } from '../server/src/sandboxes/sandboxes.service';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';

function harness() {
  const limits = new Map<string, number>();
  const audits: any[] = [];
  const queries: any[] = [];
  const users = [
    { id: ALICE, username: 'alice', email: 'a@x.dev', imageUrl: null },
    { id: ADMIN, username: 'root', email: 'r@x.dev', imageUrl: 'https://x/r.png' }
  ];
  const prisma = {
    user: {
      findMany: async (args: any) => {
        queries.push(args);
        return users.map((u) => ({
          ...u,
          limit: limits.has(u.id) ? { maxSandboxes: limits.get(u.id) } : null
        }));
      },
      count: async () => users.length,
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null
    },
    userLimit: {
      findUnique: async ({ where }: any) =>
        limits.has(where.userId) ? { maxSandboxes: limits.get(where.userId) } : null,
      upsert: async ({ where, update }: any) => {
        limits.set(where.userId, update.maxSandboxes);
      },
      deleteMany: async ({ where }: any) => {
        limits.delete(where.userId);
      }
    }
  };
  const audit = { log: async (entry: any) => audits.push(entry) };
  return {
    controller: new SandboxLimitsController(prisma as any, audit as any),
    limits,
    audits,
    queries
  };
}

test('limits are whole numbers from 0 to 100, or null for the default', () => {
  assert.equal(parseMaxSandboxes(null), null);
  assert.equal(parseMaxSandboxes(0), 0);
  assert.equal(parseMaxSandboxes(100), 100);
  for (const bad of [-1, 101, 1.5, '3', undefined, {}]) {
    assert.throws(() => parseMaxSandboxes(bad), BadRequestException, String(bad));
  }
  assert.equal(pageOf('3'), 3);
  assert.equal(pageOf('0'), 1);
  assert.equal(pageOf('x'), 1);
});

test('the list joins each user to their limit and pages by twenty', async () => {
  const h = harness();
  h.limits.set(ALICE, 4);
  const res = await h.controller.list('ali', '2');
  assert.equal(res.total, 2);
  assert.deepEqual(res.users[0], {
    id: ALICE,
    username: 'alice',
    email: 'a@x.dev',
    imageUrl: null,
    maxSandboxes: 4
  });
  assert.equal(res.users[1].maxSandboxes, null);
  assert.equal(h.queries[0].skip, 20);
  assert.equal(h.queries[0].take, 20);
  assert.deepEqual(h.queries[0].where.OR[0], {
    username: { contains: 'ali', mode: 'insensitive' }
  });
});

test('setting a limit writes the row, null deletes it, and both are audited', async () => {
  const h = harness();
  const set = await h.controller.update(ADMIN, ALICE, { maxSandboxes: 5 });
  assert.equal(set.maxSandboxes, 5);
  assert.equal(h.limits.get(ALICE), 5);
  const cleared = await h.controller.update(ADMIN, ALICE, { maxSandboxes: null });
  assert.equal(cleared.maxSandboxes, null);
  assert.equal(h.limits.has(ALICE), false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    h.audits.map((a) => [a.action, a.targetId, a.metadata]),
    [
      ['sandbox.limits.update', ALICE, { from: null, to: 5 }],
      ['sandbox.limits.update', ALICE, { from: 5, to: null }]
    ]
  );
  await assert.rejects(h.controller.update(ADMIN, ALICE, {}), BadRequestException);
  await assert.rejects(
    h.controller.update(ADMIN, ALICE, { maxSandboxes: 101 }),
    BadRequestException
  );
  await assert.rejects(
    h.controller.update(ADMIN, '33333333-3333-4333-8333-333333333333', { maxSandboxes: 1 }),
    NotFoundException
  );
});

test('the per-user limit comes from the graft table, falling back to the instance default', async () => {
  const rows = new Map<string, number | null>([[ALICE, 7]]);
  const reads: any[] = [];
  const prisma = {
    userLimit: {
      findUnique: async (args: any) => {
        reads.push(args);
        return rows.has(args.where.userId) ? { maxSandboxes: rows.get(args.where.userId) } : null;
      }
    }
  };
  const svc = Object.create(SandboxesService.prototype) as any;
  svc.prisma = prisma;
  svc.authz = { isUnrestrictedSuperAdmin: async (id: string) => id === 'root' };
  assert.equal(await svc.sandboxCap(ALICE), 7);
  assert.equal(await svc.sandboxCap(ADMIN), defaultMaxSandboxes());
  assert.equal(await svc.sandboxCap('root'), null);
  assert.deepEqual(reads[0], { where: { userId: ALICE }, select: { maxSandboxes: true } });
});
