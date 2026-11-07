import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ErrorIngestService } from '../src/observability/error-ingest.service';
import { EngineHealthController } from '../src/engine/engine-health.controller';

function ingest(members: string[]) {
  const updates: any[] = [];
  const prisma: any = {
    deployment: { findUnique: async () => ({ projectId: 'p1' }) },
    projectMember: {
      findFirst: async ({ where }: any) =>
        where.projectId === 'p1' && members.includes(where.userId) ? { id: 'm' } : null
    },
    errorGroup: {
      update: async (args: any) => {
        updates.push(args);
      }
    }
  };
  const service = Object.assign(Object.create(ErrorIngestService.prototype), { prisma });
  return { service: service as ErrorIngestService, updates };
}

test('assignee must be a member of the deployment project', async () => {
  const { service, updates } = ingest(['member']);
  await assert.rejects(
    service.updateGroup('d1', 'fp', { assigneeId: 'outsider' }, 'actor'),
    BadRequestException
  );
  assert.equal(updates.length, 0);
  await service.updateGroup('d1', 'fp', { assigneeId: 'member' }, 'actor');
  assert.equal(updates[0].data.assigneeId, 'member');
  await service.updateGroup('d1', 'fp', { assigneeId: null }, 'actor');
  assert.equal(updates[1].data.assigneeId, null);
});

function health(isSuperAdmin: boolean) {
  const mirror: any = {
    health: async () => ({
      shards: [
        { shard: 'pods', holder: 'orchard-7f9', stale: true, lastError: 'ns victim-shop-a1b2c3' },
        { shard: 'jobs', holder: 'orchard-3aa', stale: false, lastError: null }
      ],
      replicas: ['orchard-7f9', 'orchard-3aa'],
      undelivered: 12
    })
  };
  const prisma: any = { user: { findFirst: async () => ({ isSuperAdmin }) } };
  return new EngineHealthController(mirror, prisma);
}

test('engine health strips platform detail for ordinary users', async () => {
  const result: any = await health(false).health({ user: { sub: 'someone' } });
  assert.deepEqual(result, {
    shards: [{ shard: 'cluster', holder: null, stale: true }],
    replicas: [],
    undelivered: 0
  });
  assert.ok(!JSON.stringify(result).includes('victim-shop'));
});

test('engine health is complete for superadmins', async () => {
  const result: any = await health(true).health({ user: { sub: 'root' } });
  assert.equal(result.shards.length, 2);
  assert.equal(result.undelivered, 12);
});
