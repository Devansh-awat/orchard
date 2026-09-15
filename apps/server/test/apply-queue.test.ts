import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ApplyQueueService } from '../src/apply/apply-queue.service';
import { ApplyResult } from '../src/apply/apply-executor.service';

process.env.APPLY_WORKER_DISABLED = 'true';

const prisma = new PrismaClient();
const KEY = 'test:apply-queue:item';

function makeService(execute: (item: unknown) => Promise<ApplyResult>) {
  const executor = { execute } as never;
  return new ApplyQueueService(prisma as never, executor);
}

async function row() {
  return prisma.k8sApplyItem.findUnique({ where: { dedupeKey: KEY } });
}

async function drain(svc: ApplyQueueService) {
  await prisma.k8sApplyItem.updateMany({
    where: { dedupeKey: { startsWith: 'test:' }, status: 'pending' },
    data: { notBefore: new Date(Date.now() - 60_000) }
  });
  await (svc as never as { drain(): Promise<void> }).drain();
}

before(async () => {
  await prisma.k8sApplyItem.deleteMany({ where: { dedupeKey: { startsWith: 'test:' } } });
});

after(async () => {
  await prisma.k8sApplyItem.deleteMany({ where: { dedupeKey: { startsWith: 'test:' } } });
  await prisma.$disconnect();
});

test('enqueue creates a pending row and re-enqueue bumps generation', async () => {
  const svc = makeService(async () => ({ ok: true }));
  await svc.enqueue({ dedupeKey: KEY, opType: 'ssa', manifest: { a: 1 } });
  let item = await row();
  assert.equal(item?.status, 'pending');
  assert.equal(item?.generation, 1);

  await svc.enqueue({ dedupeKey: KEY, opType: 'ssa', manifest: { a: 2 } });
  item = await row();
  assert.equal(item?.generation, 2);
  const count = await prisma.k8sApplyItem.count({ where: { dedupeKey: KEY } });
  assert.equal(count, 1);
});

test('drain applies a pending item', async () => {
  let calls = 0;
  const svc = makeService(async () => {
    calls += 1;
    return { ok: true };
  });
  await drain(svc);
  assert.equal(calls, 1);
  assert.equal((await row())?.status, 'applied');
});

test('a re-enqueue during execution supersedes the applied result', async () => {
  const svc: ApplyQueueService = makeService(async () => {
    await svc.enqueue({ dedupeKey: KEY, opType: 'ssa', manifest: { a: 3 } });
    return { ok: true };
  });
  await svc.enqueue({ dedupeKey: KEY, opType: 'ssa', manifest: { a: 2 } });
  await drain(svc);
  const item = await row();
  assert.equal(item?.status, 'pending');
  assert.equal(item?.attempts, 0);
});

test('a retryable failure backs off with attempts counted', async () => {
  const svc = makeService(async () => ({ ok: false, error: 'boom' }));
  await prisma.k8sApplyItem.update({
    where: { dedupeKey: KEY },
    data: { status: 'pending', notBefore: new Date(), attempts: 0 }
  });
  await drain(svc);
  const item = await row();
  assert.equal(item?.status, 'pending');
  assert.equal(item?.attempts, 1);
  assert.ok(item!.notBefore.getTime() > Date.now());
  assert.equal(item?.lastError, 'boom');
});

test('a terminal failure marks the item failed', async () => {
  const svc = makeService(async () => ({ ok: false, terminal: true, error: 'invalid spec' }));
  await prisma.k8sApplyItem.update({
    where: { dedupeKey: KEY },
    data: { status: 'pending', notBefore: new Date(), attempts: 0 }
  });
  await drain(svc);
  const item = await row();
  assert.equal(item?.status, 'failed');
  assert.equal(item?.lastError, 'invalid spec');
});

test('two workers cannot claim the same item', async () => {
  await prisma.k8sApplyItem.update({
    where: { dedupeKey: KEY },
    data: { status: 'pending', notBefore: new Date(), attempts: 0 }
  });
  let executions = 0;
  const slow = async () => {
    executions += 1;
    await new Promise((r) => {
      setTimeout(r, 300);
    });
    return { ok: true };
  };
  const a = makeService(slow);
  const b = makeService(slow);
  await Promise.all([drain(a), drain(b)]);
  assert.equal(executions, 1);
  assert.equal((await row())?.status, 'applied');
});
