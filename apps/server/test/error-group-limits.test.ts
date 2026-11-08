import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorIngestService,
  MAX_GROUPS_PER_DEPLOYMENT,
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
  OVERFLOW_FINGERPRINT
} from '../src/observability/error-ingest.service';
import {
  ERROR_RETENTION_BATCH,
  ErrorRetentionService
} from '../src/observability/error-retention.service';

function harness(initialGroups = 0) {
  const groups = new Map<string, any>();
  for (let i = 0; i < initialGroups; i++) {
    groups.set(`seed${i}`, { id: `g${i}`, lastSeenAt: new Date(0), status: 'unresolved' });
  }
  const prisma: any = {
    deployment: { findUnique: async () => ({ projectId: 'p1' }) },
    imageHistory: { findFirst: async () => null },
    errorOccurrence: { upsert: async () => ({}) },
    errorGroup: {
      findUnique: async ({ where }: any) =>
        groups.get(where.deploymentId_fingerprint.fingerprint) ?? null,
      count: async () => groups.size,
      upsert: async ({ where, create }: any) => {
        const key = where.deploymentId_fingerprint.fingerprint;
        const row = groups.get(key) ?? { id: `n${groups.size}`, lastSeenAt: new Date(0) };
        groups.set(key, { ...row, ...create });
        return { id: row.id };
      }
    }
  };
  const batch = (n: number, long = false) =>
    Array.from({ length: n }, (_, i) => ({
      fingerprint: `fp${i}`,
      type: 'Error',
      message: long ? 'm'.repeat(100_000) : `boom ${i}`,
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      samples: [
        { timestamp: new Date().toISOString(), stackTrace: long ? 's'.repeat(100_000) : null }
      ]
    }));
  let errors: any[] = [];
  const service = new ErrorIngestService(
    prisma,
    { isLeader: () => true } as any,
    { getErrors: async () => ({ errors }) } as any,
    { configured: false } as any
  );
  return {
    groups,
    service,
    feed: (n: number, long = false) => {
      errors = batch(n, long);
    }
  };
}

test('a tenant minting distinct error types is folded into one overflow group', async () => {
  const { groups, service, feed } = harness();
  feed(MAX_GROUPS_PER_DEPLOYMENT + 300);
  await service.ingest('d1');
  assert.equal(groups.size, MAX_GROUPS_PER_DEPLOYMENT + 1);
  assert.ok(groups.has(OVERFLOW_FINGERPRINT));
  assert.equal(groups.get(OVERFLOW_FINGERPRINT).type, 'other');
});

test('a deployment already over the cap keeps existing groups and creates no new ones', async () => {
  const { groups, service, feed } = harness(MAX_GROUPS_PER_DEPLOYMENT + 50);
  const before = groups.size;
  feed(20);
  await service.ingest('d1');
  assert.equal(groups.size, before + 1);
  assert.ok(groups.has(OVERFLOW_FINGERPRINT));
});

test('message and stack are truncated before storage', async () => {
  const { groups, service, feed } = harness();
  feed(1, true);
  await service.ingest('d1');
  const row = groups.get('fp0');
  assert.equal(row.message.length, MAX_MESSAGE_LENGTH);
  assert.equal(row.sampleStack.length, MAX_STACK_LENGTH);
});

function retention(total: number, canCoordinate = true, leader = true) {
  let rows = Array.from({ length: total }, (_, i) => ({ id: String(i) }));
  const deleteSizes: number[] = [];
  const cutoffs: Date[] = [];
  const prisma: any = {
    errorGroup: {
      findMany: async ({ take, where }: any) => {
        cutoffs.push(where.lastSeenAt.lt);
        return rows.slice(0, take);
      },
      deleteMany: async ({ where }: any) => {
        const ids = new Set(where.id.in);
        deleteSizes.push(ids.size);
        const before = rows.length;
        rows = rows.filter((r) => !ids.has(r.id));
        return { count: before - rows.length };
      }
    }
  };
  const service = new ErrorRetentionService(
    prisma,
    { isLeader: () => leader } as any,
    { canCoordinate } as any
  );
  return { service, deleteSizes, cutoffs, remaining: () => rows.length };
}

test('retention deletes stale groups in bounded batches', async () => {
  const { service, deleteSizes, cutoffs, remaining } = retention(ERROR_RETENTION_BATCH * 2 + 7);
  const now = Date.now();
  const removed = await service.prune(now);
  assert.equal(removed, ERROR_RETENTION_BATCH * 2 + 7);
  assert.equal(remaining(), 0);
  assert.ok(deleteSizes.every((n) => n <= ERROR_RETENTION_BATCH));
  assert.equal(cutoffs[0].getTime(), now - 90 * 24 * 60 * 60 * 1000);
});

test('retention only runs on the coordinating leader', async () => {
  const noLease = retention(10, false, true);
  await noLease.service.tick();
  assert.equal(noLease.remaining(), 10);
  const follower = retention(10, true, false);
  await follower.service.tick();
  assert.equal(follower.remaining(), 10);
  const leader = retention(10, true, true);
  await leader.service.tick();
  assert.equal(leader.remaining(), 0);
});
