import test from 'node:test';
import assert from 'node:assert/strict';
import { IngressConsumer } from '../src/engine/consumers/ingress.consumer';
import { ServiceConsumer } from '../src/engine/consumers/service.consumer';

type Live = 'present' | 'absent' | 'unknown';

const OLD = new Date(Date.now() - 60 * 60 * 1000);

function ingressRow(id: string, name: string, path = '/') {
  return {
    id,
    projectId: 'p1',
    deploymentId: 'd1',
    namespace: 'acme',
    name,
    host: `${name}.example.com`,
    path,
    project: { organizationId: 'o1' }
  };
}

function buildIngress(
  rows: ReturnType<typeof ingressRow>[],
  live: Record<string, Live>,
  observed?: string[]
) {
  const deleted: string[] = [];
  const audits: any[] = [];
  const reads: string[] = [];
  const prisma = {
    ingress: {
      findMany: async ({ where }: any) =>
        rows.filter(
          (r) =>
            (where.namespace === undefined || r.namespace === where.namespace) &&
            (where.name === undefined || r.name === where.name)
        ),
      delete: async ({ where }: any) => {
        deleted.push(where.id);
      }
    }
  };
  const consumer = new IngressConsumer(
    prisma as any,
    { log: async (entry: any) => audits.push(entry) } as any,
    {} as any,
    { emit: () => {} } as any
  );
  (consumer as any).liveIngress = async (ns: string, name: string) => {
    reads.push(`${ns}/${name}`);
    return live[`${ns}/${name}`] ?? 'absent';
  };
  (consumer as any).observed = async (keys: { namespace: string; name: string }[]) =>
    new Set(
      keys
        .map((k) => `${k.namespace}/${k.name}`)
        .filter((key) => observed === undefined || observed.includes(key))
    );
  return { consumer, deleted, audits, reads };
}

const ingress = (name: string) => ({ metadata: { name, namespace: 'acme' } }) as any;

test('an ingress that is really gone still has its rows removed', async () => {
  const { consumer, deleted, audits } = buildIngress([ingressRow('i1', 'web')], {});
  await consumer.onEvent('delete', ingress('web'));
  assert.deepEqual(deleted, ['i1']);
  assert.equal(audits[0].metadata.reason, 'resource deleted in k8s');
});

test('an ingress that only lost its label keeps its rows on the watch', async () => {
  const { consumer, deleted } = buildIngress([ingressRow('i1', 'web')], {
    'acme/web': 'present'
  });
  await consumer.onEvent('delete', ingress('web'));
  assert.deepEqual(deleted, []);
});

test('an apiserver that cannot answer defers the watch delete', async () => {
  const { consumer, deleted } = buildIngress([ingressRow('i1', 'web')], {
    'acme/web': 'unknown'
  });
  await assert.rejects(consumer.onEvent('delete', ingress('web')));
  assert.deepEqual(deleted, []);
});

test('the list prune checks each missing object once and only drops the gone ones', async () => {
  const { consumer, deleted, reads } = buildIngress(
    [
      ingressRow('i1', 'gone', '/'),
      ingressRow('i2', 'gone', '/api'),
      ingressRow('i3', 'unlabeled'),
      ingressRow('i4', 'flaky'),
      ingressRow('i5', 'seen')
    ],
    { 'acme/unlabeled': 'present', 'acme/flaky': 'unknown' }
  );
  await consumer.pruneStaleRows([{ namespace: 'acme', name: 'seen', refs: {} }]);
  assert.deepEqual(deleted.sort(), ['i1', 'i2']);
  assert.deepEqual(reads.sort(), ['acme/flaky', 'acme/gone', 'acme/unlabeled']);
});

test('the list prune leaves rows alone when this cluster never had their ingress', async () => {
  const { consumer, deleted, reads } = buildIngress(
    [ingressRow('i1', 'restored'), ingressRow('i2', 'deleted'), ingressRow('i3', 'seen')],
    {},
    ['acme/deleted']
  );
  await consumer.pruneStaleRows([{ namespace: 'acme', name: 'seen', refs: {} }]);
  assert.deepEqual(deleted, ['i2']);
  assert.deepEqual(reads, ['acme/deleted']);
});

function serviceRow(name: string) {
  return {
    id: `s-${name}`,
    name,
    deploymentId: 'd1',
    type: 'internal',
    port: 80,
    targetPort: 3000,
    protocol: 'TCP',
    externalIp: null,
    nodePort: null,
    updatedAt: OLD,
    ports: [],
    deployment: {
      namespace: 'acme',
      buildStatus: 'succeeded',
      projectId: 'p1',
      project: { organizationId: 'o1' }
    }
  };
}

function buildService(rows: ReturnType<typeof serviceRow>[], live: Record<string, Live>) {
  const deleted: string[] = [];
  const prisma = {
    service: {
      findFirst: async ({ where }: any) => rows.find((r) => r.name === where.name) ?? null,
      findMany: async () => rows,
      delete: async ({ where }: any) => {
        deleted.push(where.id);
      }
    },
    k8sWorkload: { findUnique: async () => ({ deploymentId: 'd1' }) }
  };
  const consumer = new ServiceConsumer(
    prisma as any,
    { emit: () => {} } as any,
    { log: async () => {} } as any,
    {} as any
  );
  (consumer as any).liveService = async (ns: string, name: string) =>
    live[`${ns}/${name}`] ?? 'absent';
  return { consumer, deleted };
}

const service = (name: string) => ({ metadata: { name, namespace: 'acme' } }) as any;

test('a service that is really gone is pruned on the watch', async () => {
  const { consumer, deleted } = buildService([serviceRow('web')], {});
  await consumer.onEvent('delete', service('web'));
  assert.deepEqual(deleted, ['s-web']);
});

test('a service that only lost its label is kept on the watch', async () => {
  const { consumer, deleted } = buildService([serviceRow('web')], { 'acme/web': 'present' });
  await consumer.onEvent('delete', service('web'));
  assert.deepEqual(deleted, []);
});

test('an unreadable apiserver defers the service watch delete', async () => {
  const { consumer, deleted } = buildService([serviceRow('web')], { 'acme/web': 'unknown' });
  await assert.rejects(consumer.onEvent('delete', service('web')));
  assert.deepEqual(deleted, []);
});

test('the service list prune only drops services the apiserver says are gone', async () => {
  const { consumer, deleted } = buildService(
    [serviceRow('gone'), serviceRow('unlabeled'), serviceRow('flaky'), serviceRow('seen')],
    { 'acme/unlabeled': 'present', 'acme/flaky': 'unknown' }
  );
  await consumer.pruneStaleRows([{ namespace: 'acme', name: 'seen', refs: {} }]);
  assert.deepEqual(deleted, ['s-gone']);
});
