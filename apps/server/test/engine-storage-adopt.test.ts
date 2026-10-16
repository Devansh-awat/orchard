import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageConsumer, grownStorageSize } from '../src/engine/consumers/storage.consumer';

function volume(extra: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    name: 'data',
    deploymentId: 'd1',
    storageSize: '5Gi' as string | null,
    observedCapacity: '5Gi' as string | null,
    phase: 'Bound' as string | null,
    resizeState: null as string | null,
    resizeMessage: null as string | null,
    deployment: { projectId: 'p1', project: { organizationId: 'o1' } },
    ...extra
  };
}

function build(
  rows: ReturnType<typeof volume>[],
  live: 'present' | 'absent' | 'unknown' = 'absent'
) {
  const updates: { id: string; data: any }[] = [];
  const emitted: any[] = [];
  const prisma = {
    deploymentVolume: {
      findMany: async () => rows,
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
      }
    }
  };
  const consumer = new StorageConsumer(
    prisma as any,
    { emit: (e: any) => emitted.push(e) } as any,
    { log: async () => {} } as any,
    {} as any
  );
  (consumer as any).livePvc = async () => live;
  return { consumer, updates, emitted };
}

const pvc = (requested: string, capacity = requested) =>
  ({
    metadata: { name: 'data', namespace: 'acme' },
    spec: { resources: { requests: { storage: requested } } },
    status: { phase: 'Bound', capacity: { storage: capacity } }
  }) as any;

test('only a strictly larger request counts as growth', () => {
  assert.equal(grownStorageSize('5Gi', '10Gi'), '10Gi');
  assert.equal(grownStorageSize('5Gi', '5Gi'), null);
  assert.equal(grownStorageSize('5Gi', '5120Mi'), null);
  assert.equal(grownStorageSize('10Gi', '5Gi'), null);
});

test('an unset size is the 1Gi orchard created the claim with', () => {
  assert.equal(grownStorageSize(null, '1Gi'), null);
  assert.equal(grownStorageSize(null, '2Gi'), '2Gi');
});

test('quantities orchard cannot read are never adopted', () => {
  assert.equal(grownStorageSize('5Gi', null), null);
  assert.equal(grownStorageSize('5Gi', 'lots'), null);
  assert.equal(grownStorageSize('5Gi', '1' + '0'.repeat(30)), null);
  assert.equal(grownStorageSize('garbage', '10Gi'), null);
});

test('a claim grown with kubectl lands in storage_size', async () => {
  const { consumer, updates, emitted } = build([volume()]);
  await consumer.onEvent('update', pvc('20Gi', '5Gi'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.storageSize, '20Gi');
  assert.equal(updates[0].data.observedCapacity, '5Gi');
  assert.equal(updates[0].data.resizeState, 'resizing');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'deployment.changed');
});

test('a claim smaller than the stored size never shrinks it', async () => {
  const { consumer, updates } = build([volume({ storageSize: '50Gi' })]);
  await consumer.onEvent('update', pvc('20Gi'));
  assert.equal(updates.length, 1);
  assert.equal('storageSize' in updates[0].data, false);
});

test('a delete leaves the size alone and only marks the volume missing', async () => {
  const { consumer, updates } = build([volume()]);
  await consumer.onEvent('delete', pvc('20Gi'));
  assert.equal('storageSize' in updates[0].data, false);
  assert.equal(updates[0].data.phase, 'Missing');
});

test('a claim that only lost its label is not marked missing', async () => {
  const { consumer, updates } = build([volume()], 'present');
  await consumer.onEvent('delete', pvc('5Gi'));
  assert.deepEqual(updates, []);
});

test('an apiserver that cannot answer never marks a volume missing', async () => {
  const { consumer, updates } = build([volume()], 'unknown');
  await assert.rejects(consumer.onEvent('delete', pvc('5Gi')));
  assert.deepEqual(updates, []);
});

test('an unchanged claim emits nothing', async () => {
  const { consumer, emitted } = build([volume()]);
  await consumer.onEvent('update', pvc('5Gi'));
  assert.deepEqual(emitted, []);
});
