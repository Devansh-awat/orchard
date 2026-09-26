import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';
import { DeploymentsService } from '../src/projects/deployments.service';

function harness(rows: any[], live: Map<string, { name: string; port: number }> | null) {
  const sets: unknown[] = [];
  const updates: unknown[] = [];
  let proxied = 0;
  const svc = Object.create(K8sNetworkService.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {}, log() {} },
    prisma: {
      ingress: {
        findMany: async () => rows,
        update: async (args: any) => {
          updates.push(args);
          return {};
        }
      }
    },
    enableProtectionProxy: async () => {
      proxied += 1;
      return 'applied';
    },
    readIngressBackends: async () => live,
    setIngressBackends: async (_ns: string, _name: string, backends: unknown) => {
      sets.push(backends);
      return 'applied';
    }
  });
  return { svc, sets, updates, proxied: () => proxied };
}

const service = (over: Partial<any> = {}) => ({
  name: 'web',
  port: 3000,
  ports: [
    { port: 3000, targetPort: 3000, protocol: 'TCP' },
    { port: 9090, targetPort: 9090, protocol: 'TCP' }
  ],
  ...over
});

test('a protected domain stays on the proxy and never gets a port patched onto it', async () => {
  const { svc, sets, proxied } = harness(
    [
      {
        id: 'i1',
        path: '/',
        protectionMode: 'orchard',
        redirectTarget: null,
        servicePort: null,
        service: service()
      }
    ],
    new Map([['/', { name: 'orchard-protection-proxy', port: 3001 }]])
  );
  assert.equal(await svc.syncIngressBackends('ns', 'web-abc'), 'proxy');
  assert.equal(proxied(), 1);
  assert.equal(sets.length, 0);
});

test('an unprotected domain follows the service to its new port and the choice is persisted', async () => {
  const { svc, sets, updates } = harness(
    [
      {
        id: 'i1',
        path: '/',
        protectionMode: 'none',
        redirectTarget: null,
        servicePort: null,
        service: service({ port: 8080, ports: [{ port: 8080, targetPort: 8080, protocol: 'TCP' }] })
      }
    ],
    new Map([['/', { name: 'web', port: 3000 }]])
  );
  assert.equal(await svc.syncIngressBackends('ns', 'web-abc'), 'applied');
  assert.deepEqual(sets[0], [{ path: '/', serviceName: 'web', servicePort: 8080 }]);
  assert.equal((updates[0] as any).data.servicePort, 8080);
});

test('a domain on the second port keeps its own port when the first one changes', async () => {
  const { svc, sets, updates } = harness(
    [
      {
        id: 'i1',
        path: '/',
        protectionMode: 'none',
        redirectTarget: null,
        servicePort: 9090,
        service: service({
          port: 8080,
          ports: [
            { port: 8080, targetPort: 8080, protocol: 'TCP' },
            { port: 9090, targetPort: 9090, protocol: 'TCP' }
          ]
        })
      }
    ],
    new Map([['/', { name: 'web', port: 9090 }]])
  );
  await svc.syncIngressBackends('ns', 'metrics-abc');
  assert.deepEqual(sets[0], [{ path: '/', serviceName: 'web', servicePort: 9090 }]);
  assert.equal(updates.length, 0);
});

test('a row that never recorded its port learns it from the cluster', async () => {
  const { svc, sets, updates } = harness(
    [
      {
        id: 'i1',
        path: '/',
        protectionMode: 'none',
        redirectTarget: null,
        servicePort: null,
        service: service()
      }
    ],
    new Map([['/', { name: 'web', port: 9090 }]])
  );
  await svc.syncIngressBackends('ns', 'metrics-abc');
  assert.equal((updates[0] as any).data.servicePort, 9090);
  assert.deepEqual(sets[0], [{ path: '/', serviceName: 'web', servicePort: 9090 }]);
});

test('a sync that fails is queued so it retries instead of being logged and lost', async () => {
  const queued: unknown[] = [];
  const svc = Object.create(DeploymentsService.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    prisma: { ingress: { findMany: async () => [{ namespace: 'ns', name: 'web-abc' }] } },
    k8sNetwork: {
      syncIngressBackends: async () => {
        throw new Error('apiserver away');
      }
    },
    applyQueue: { enqueue: async (input: unknown) => queued.push(input) }
  });
  await svc.syncIngressesForService('svc-1', 'dep-1');
  assert.equal(queued.length, 1);
  assert.equal((queued[0] as any).opType, 'ingress.sync');
  assert.equal((queued[0] as any).dedupeKey, 'op:ingress.sync:ns/web-abc');
});
