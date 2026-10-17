import test from 'node:test';
import assert from 'node:assert/strict';
import { K8sNodeInformerService } from '../src/kubernetes/k8s-node-informer.service';

function harness(live: () => 'present' | 'absent' | 'unknown') {
  const removed: string[] = [];
  const upserted: string[] = [];
  const service = new K8sNodeInformerService(
    {} as any,
    { isLeader: () => true } as any,
    {
      removeNodeByName: async (name: string) => removed.push(name),
      upsertNodeRow: async (row: any) => upserted.push(row.name)
    } as any
  );
  (service as any).removeAfterMs = 5;
  (service as any).liveNode = async () => live();
  const event = (type: string, name: string) =>
    (service as any).onNodeEvent(type, { metadata: { name }, spec: {}, status: {} });
  return { service, removed, upserted, event };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a node deleted and re-registered keeps its row and assignments', async () => {
  const { service, removed, event } = harness(() => 'absent');
  await event('delete', 'node-a');
  await event('add', 'node-a');
  await settle();
  assert.deepEqual(removed, []);
  await service.onModuleDestroy();
});

test('a node that is really gone is removed only after the wait', async () => {
  const { service, removed, event } = harness(() => 'absent');
  await event('delete', 'node-b');
  assert.deepEqual(removed, []);
  await settle();
  assert.deepEqual(removed, ['node-b']);
  await service.onModuleDestroy();
});

test('an apiserver that cannot answer never removes a node', async () => {
  const { service, removed, event } = harness(() => 'unknown');
  await event('delete', 'node-c');
  await settle();
  assert.deepEqual(removed, []);
  await service.onModuleDestroy();
});
