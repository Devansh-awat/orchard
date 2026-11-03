import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';

function service(statusCode: number | null, cilium: boolean) {
  const svc = Object.create(K8sNetworkService.prototype) as any;
  const deleted: string[] = [];
  svc.kubernetes = {
    ensureKubeConfig: () => {},
    isCiliumAvailable: async () => cilium,
    kc: {
      makeApiClient: () => ({
        deleteNamespacedCustomObject: async (
          _group: string,
          _version: string,
          _namespace: string,
          _plural: string,
          name: string
        ) => {
          deleted.push(name);
          if (statusCode !== null) {
            throw Object.assign(new Error('HTTP request failed'), {
              response: { statusCode },
              body: { message: 'forbidden' }
            });
          }
        }
      })
    }
  };
  return { svc: svc as K8sNetworkService, deleted };
}

async function loggedErrors(fn: () => Promise<void>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}

test('a cluster without Cilium stays quiet when the delete is forbidden', async () => {
  const { svc, deleted } = service(403, false);
  const logged = await loggedErrors(async () => {
    await svc.deleteBasicAuthMiddleware('acme', 'web');
    await svc.deleteHttpsRedirectMiddleware('acme', 'web');
  });
  assert.deepEqual(logged, []);
  assert.deepEqual(deleted, ['web-auth', 'web-https-redirect']);
});

test('a forbidden delete on a Cilium cluster logs one line with no error object', async () => {
  const { svc } = service(403, true);
  const logged = await loggedErrors(() => svc.deleteBasicAuthMiddleware('acme', 'web'));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].length, 1);
  assert.equal(typeof logged[0][0], 'string');
  assert.match(String(logged[0][0]), /web-auth in acme/);
});

test('a missing object is fine anywhere, and the delete is still attempted', async () => {
  const { svc, deleted } = service(404, true);
  assert.deepEqual(await loggedErrors(() => svc.deleteBasicAuthMiddleware('acme', 'web')), []);
  assert.deepEqual(deleted, ['web-auth']);
});
