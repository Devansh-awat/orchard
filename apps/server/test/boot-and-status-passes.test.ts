import assert from 'node:assert/strict';
import test from 'node:test';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';

test('the boot repair of protection proxies waits for leadership', () => {
  const listeners: (() => void)[] = [];
  const service = new K8sNetworkService(
    {} as any,
    {} as any,
    { onAcquired: (listener: () => void) => listeners.push(listener), isLeader: () => false } as any
  );
  const passes: string[] = [];
  (service as any).reconcileProtectionProxies = async () => passes.push('proxies');
  (service as any).reconcileWildcardSecrets = async () => passes.push('wildcards');
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({ unref: () => undefined })) as any;
  try {
    service.onModuleInit();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.deepEqual(passes, []);
  assert.equal(listeners.length, 1);
  listeners[0]();
  assert.deepEqual(passes, ['proxies', 'wildcards']);
});

function cnpgConsumer(rows: { current: any }) {
  const consumer = Object.create(CnpgConsumer.prototype) as any;
  let lookups = 0;
  consumer.ctxCache = new Map();
  consumer.prisma = {
    database: {
      findFirst: async () => {
        lookups += 1;
        return rows.current;
      }
    }
  };
  return { consumer, lookups: () => lookups };
}

const row = { id: 'db', projectId: 'p', project: { organizationId: 'o' } };

test('a cluster event sees a database row created just after the cluster', async () => {
  const rows = { current: null as any };
  const { consumer } = cnpgConsumer(rows);
  assert.deepEqual(await consumer.mapClusterRefs({ metadata: { namespace: 'n', name: 'pg' } }), {});
  rows.current = row;
  assert.deepEqual(await consumer.mapClusterRefs({ metadata: { namespace: 'n', name: 'pg' } }), {
    databaseId: 'db',
    projectId: 'p'
  });
});

test('pod events keep using the cached answer for a cluster with no row', async () => {
  const rows = { current: null as any };
  const { consumer, lookups } = cnpgConsumer(rows);
  const pod = { metadata: { namespace: 'n', labels: { 'cnpg.io/cluster': 'pg' } } };
  await consumer.mapPodRefs(pod);
  await consumer.mapPodRefs(pod);
  assert.equal(lookups(), 1);
});
