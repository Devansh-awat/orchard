import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentsService } from '../src/projects/deployments.service';
import { ResourceBindingsService } from '../src/projects/resource-bindings.service';

const DB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DB = '22222222-2222-4222-8222-222222222222';

function fakeBindings(rows: { deploymentId: string; name: string; resourceId: string }[]) {
  const prisma = {
    resourceBinding: {
      findMany: async ({ where }: { where: { resourceType: string; resourceId: string } }) =>
        rows
          .filter((r) => where.resourceType === 'database' && r.resourceId === where.resourceId)
          .map((r) => ({ deployment: { id: r.deploymentId, name: r.name } }))
    }
  };
  const svc = Object.create(ResourceBindingsService.prototype) as ResourceBindingsService;
  (svc as unknown as { prisma: unknown }).prisma = prisma;
  return svc;
}

function fakeDeployments(bindings: ResourceBindingsService, pipeline: boolean) {
  const svc = Object.create(DeploymentsService.prototype) as DeploymentsService;
  const applied: string[] = [];
  const enqueued: string[] = [];
  Object.assign(svc, {
    resourceBindings: bindings,
    logger: { warn: () => {}, log: () => {} },
    applyPipelineEnabled: () => pipeline,
    applyEnvToCluster: async (id: string) => {
      if (id === 'boom') throw new Error('cluster said no');
      applied.push(id);
    },
    applyQueue: {
      enqueue: async (op: { deploymentId: string; opType: string }) => {
        enqueued.push(`${op.opType}:${op.deploymentId}`);
      }
    }
  });
  return { svc, applied, enqueued };
}

test('a credential change re-applies env to every bound deployment and no other', async () => {
  const bindings = fakeBindings([
    { deploymentId: 'web', name: 'web', resourceId: DB_ID },
    { deploymentId: 'api', name: 'api', resourceId: DB_ID },
    { deploymentId: 'worker', name: 'worker', resourceId: OTHER_DB }
  ]);
  const { svc, applied } = fakeDeployments(bindings, false);
  const names = await svc.reapplyEnvForResource('database', DB_ID);
  assert.deepEqual(names.sort(), ['api', 'web']);
  assert.deepEqual(applied.sort(), ['api', 'web']);
});

test('one deployment failing to re-apply does not stop the others', async () => {
  const bindings = fakeBindings([
    { deploymentId: 'boom', name: 'boom', resourceId: DB_ID },
    { deploymentId: 'web', name: 'web', resourceId: DB_ID }
  ]);
  const { svc, applied } = fakeDeployments(bindings, false);
  const names = await svc.reapplyEnvForResource('database', DB_ID);
  assert.deepEqual(names.sort(), ['boom', 'web']);
  assert.deepEqual(applied, ['web']);
});

test('with the apply pipeline on, the re-apply goes through the queue as the same op a save uses', async () => {
  const bindings = fakeBindings([{ deploymentId: 'web', name: 'web', resourceId: DB_ID }]);
  const { svc, applied, enqueued } = fakeDeployments(bindings, true);
  await svc.reapplyEnvForResource('database', DB_ID);
  assert.deepEqual(applied, []);
  assert.deepEqual(enqueued, ['deployment.updateEnv:web']);
});

test('a database bound to nothing re-applies nothing', async () => {
  const bindings = fakeBindings([]);
  const { svc, applied } = fakeDeployments(bindings, false);
  assert.deepEqual(await svc.reapplyEnvForResource('database', DB_ID), []);
  assert.deepEqual(applied, []);
});
