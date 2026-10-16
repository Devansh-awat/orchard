import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceConsumer, observedServiceType } from '../src/engine/consumers/service.consumer';

const OLD = new Date(Date.now() - 60 * 60 * 1000);

function serviceRow(extra: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'web',
    deploymentId: 'd1',
    type: 'internal',
    port: 80,
    targetPort: 3000,
    protocol: 'TCP',
    externalIp: null as string | null,
    nodePort: null as number | null,
    updatedAt: OLD,
    ports: [
      {
        id: 'sp1',
        name: 'http',
        port: 80,
        targetPort: 3000,
        protocol: 'TCP',
        nodePort: null as number | null,
        publicEnabled: false,
        publicPort: null
      }
    ],
    deployment: {
      namespace: 'acme',
      buildStatus: 'succeeded',
      projectId: 'p1',
      project: { organizationId: 'o1' }
    },
    ...extra
  };
}

function build(row: ReturnType<typeof serviceRow>, pendingApply = 0) {
  const updates: Record<string, unknown>[] = [];
  const emitted: any[] = [];
  const prisma = {
    service: { findFirst: async () => row },
    k8sApplyItem: { count: async () => pendingApply },
    servicePort: {
      create: async () => ({}),
      update: async () => ({}),
      deleteMany: async () => ({})
    },
    $transaction: async (fn: (tx: any) => Promise<void>) =>
      fn({
        service: {
          update: async ({ data }: any) => {
            updates.push(data);
          }
        }
      })
  };
  const consumer = new ServiceConsumer(
    prisma as any,
    { emit: (e: any) => emitted.push(e) } as any,
    { log: async () => {} } as any
  );
  return { consumer, updates, emitted };
}

const svc = (type: string, nodePort?: number) =>
  ({
    metadata: { name: 'web', namespace: 'acme' },
    spec: {
      type,
      ports: [{ name: 'http', port: 80, targetPort: 3000, protocol: 'TCP', nodePort }]
    }
  }) as any;

test('ClusterIP reads as internal, NodePort and LoadBalancer as external', () => {
  assert.equal(observedServiceType(svc('ClusterIP'), 'external'), 'internal');
  assert.equal(observedServiceType(svc('NodePort'), 'internal'), 'external');
  assert.equal(observedServiceType(svc('LoadBalancer'), 'internal'), 'external');
});

test('kinds orchard has no type for are left alone', () => {
  assert.equal(observedServiceType(svc('ExternalName'), 'internal'), null);
  assert.equal(observedServiceType({ spec: {} } as any, 'internal'), null);
  assert.equal(observedServiceType(svc('NodePort'), 'ingress'), null);
});

test('a service switched to NodePort in k8s becomes external', async () => {
  const { consumer, updates, emitted } = build(serviceRow());
  await consumer.onEvent('update', svc('NodePort', 31000));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, 'external');
  assert.equal(updates[0].nodePort, 31000);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'deployment.changed');
  assert.equal(emitted[0].id, 'd1');
});

test('going back to ClusterIP clears the external address like orchard does', async () => {
  const { consumer, updates } = build(
    serviceRow({ type: 'external', externalIp: '10.0.0.5', nodePort: 31000 })
  );
  await consumer.onEvent('update', svc('ClusterIP'));
  assert.equal(updates[0].type, 'internal');
  assert.equal(updates[0].externalIp, null);
  assert.equal(updates[0].nodePort, null);
});

test('a matching type writes nothing', async () => {
  const { consumer, updates, emitted } = build(serviceRow());
  await consumer.onEvent('update', svc('ClusterIP'));
  assert.deepEqual(updates, []);
  assert.deepEqual(emitted, []);
});

test('a legacy ingress-typed row is never retyped', async () => {
  const { consumer, updates } = build(serviceRow({ type: 'ingress' }));
  await consumer.onEvent('update', svc('NodePort', 31000));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, undefined);
});

test('adoption waits for queued applies and builds', async () => {
  const queued = build(serviceRow(), 1);
  await assert.rejects(queued.consumer.onEvent('update', svc('NodePort', 31000)));
  assert.deepEqual(queued.updates, []);

  const building = build(
    serviceRow({
      deployment: {
        namespace: 'acme',
        buildStatus: 'building',
        projectId: 'p1',
        project: { organizationId: 'o1' }
      }
    })
  );
  await assert.rejects(building.consumer.onEvent('update', svc('NodePort', 31000)));
  assert.deepEqual(building.updates, []);
});
