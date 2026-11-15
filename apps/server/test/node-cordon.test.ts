import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { NodesService } from '../src/nodes/nodes.service';

function harness(opts: { patchError?: unknown } = {}) {
  const row = { id: 'n1', name: 'node-a', schedulable: true, taints: [] as unknown[] };
  const patches: { name: string; patch: any }[] = [];
  const updates: any[] = [];
  const audits: string[] = [];
  const prisma = {
    node: {
      findUnique: async () => ({ ...row }),
      upsert: async (args: any) => {
        row.schedulable = args.update.schedulable;
        return row;
      },
      update: async (args: any) => {
        updates.push(args.data);
        return { ...row, ...args.data };
      }
    },
    pod: { findMany: async () => [] },
    clusterEvent: { upsert: async () => ({}) }
  };
  const k8s = {
    patchNode: async (name: string, patch: any) => {
      patches.push({ name, patch });
      if (opts.patchError) throw opts.patchError;
      return {
        metadata: { name },
        spec: { unschedulable: patch.spec.unschedulable },
        status: { capacity: { cpu: '4', memory: '8Gi' } }
      };
    }
  };
  const audit = {
    log: async (e: { action: string }) => {
      audits.push(e.action);
    }
  };
  const service = new NodesService(prisma as any, k8s as any, {} as any, {} as any, audit as any);
  return { service, row, patches, updates, audits };
}

test('cordon patches spec.unschedulable on the kubernetes node', async () => {
  const { service, row, patches, updates, audits } = harness();
  const result = await service.updateNode('n1', { schedulable: false });
  assert.deepEqual(patches, [{ name: 'node-a', patch: { spec: { unschedulable: true } } }]);
  assert.equal(row.schedulable, false);
  assert.equal(result.schedulable, false);
  assert.deepEqual(updates, [{}]);
  assert.deepEqual(audits, ['node.cordoned']);
});

test('uncordon clears spec.unschedulable', async () => {
  const { service, patches, audits } = harness();
  await service.updateNode('n1', { schedulable: true });
  assert.deepEqual(patches[0].patch, { spec: { unschedulable: false } });
  assert.deepEqual(audits, ['node.uncordoned']);
});

test('a failed patch surfaces an error and leaves the row alone', async () => {
  const error = Object.assign(new Error('HTTP request failed'), {
    name: 'HttpError',
    statusCode: 403,
    body: { message: 'nodes "node-a" is forbidden' }
  });
  const { service, row, updates, audits } = harness({ patchError: error });
  await assert.rejects(
    service.updateNode('n1', { schedulable: false }),
    (e: unknown) =>
      e instanceof HttpException &&
      e.getStatus() === 502 &&
      /Couldn't cordon node-a: nodes "node-a" is forbidden/.test(e.message)
  );
  assert.equal(row.schedulable, true);
  assert.deepEqual(updates, []);
  assert.deepEqual(audits, []);
});

test('notes update without touching the cluster', async () => {
  const { service, patches, updates } = harness();
  await service.updateNode('n1', { notes: 'rack 4' });
  assert.deepEqual(patches, []);
  assert.deepEqual(updates, [{ notes: 'rack 4' }]);
});
