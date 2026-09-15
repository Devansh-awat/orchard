import { test } from 'node:test';
import assert from 'node:assert';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';

// The service is exercised directly with a stubbed kube client: the mapping
// from cert-manager conditions to a state is the whole point of the method, and
// it is what decides whether the UI tells someone their certificate failed.
function serviceWith(items: any[] | Error) {
  const svc = Object.create(K8sNetworkService.prototype) as any;
  svc.logger = { warn() {} };
  svc.kubernetes = {
    kc: {
      makeApiClient: () => ({
        listNamespacedCustomObject: async () => {
          if (items instanceof Error) throw items;
          return { body: { items } };
        }
      })
    }
  };
  Object.defineProperty(svc, 'kc', {
    get() {
      return svc.kubernetes.kc;
    }
  });
  return svc as K8sNetworkService;
}

function cert(conditions: any[], extra: Record<string, unknown> = {}) {
  return { spec: { secretName: 'my-tls' }, status: { conditions, ...extra } };
}

test('a Ready certificate reports ready and carries its expiry', async () => {
  const svc = serviceWith([
    cert([{ type: 'Ready', status: 'True' }], { notAfter: '2026-12-01T00:00:00Z' })
  ]);
  const r = await svc.getCertificateStatus('ns', 'my-tls');
  assert.equal(r.state, 'ready');
  assert.equal(r.notAfter, '2026-12-01T00:00:00Z');
});

test('a hard failure reports failed with the reason cert-manager gave', async () => {
  const svc = serviceWith([
    cert([
      { type: 'Ready', status: 'False', reason: 'Failed', message: 'order is in state failed' }
    ])
  ]);
  const r = await svc.getCertificateStatus('ns', 'my-tls');
  assert.equal(r.state, 'failed');
  assert.equal(r.message, 'order is in state failed');
});

// The remedy for this one is a wildcard, not anything about this host, so it
// must not be lumped in with ordinary failures.
test('an ACME rate limit is separated from other failures', async () => {
  const svc = serviceWith([
    cert([
      {
        type: 'Ready',
        status: 'False',
        reason: 'Failed',
        message:
          'acme: error 429 - urn:ietf:params:acme:error:rateLimited: too many certificates already issued for "example.com"'
      }
    ])
  ]);
  const r = await svc.getCertificateStatus('ns', 'my-tls');
  assert.equal(r.state, 'rateLimited');
});

test('an in-flight order reports issuing rather than failed', async () => {
  const svc = serviceWith([
    cert([{ type: 'Ready', status: 'False', reason: 'InProgress', message: 'waiting on order' }])
  ]);
  assert.equal((await svc.getCertificateStatus('ns', 'my-tls')).state, 'issuing');
});

test('a Secret with no matching Certificate is unknown, not failed', async () => {
  const svc = serviceWith([{ spec: { secretName: 'someone-elses-tls' }, status: {} }]);
  assert.equal((await svc.getCertificateStatus('ns', 'my-tls')).state, 'unknown');
});

// A cluster without cert-manager must not turn every domain row into an error.
test('a missing CRD or denied read degrades to unknown', async () => {
  for (const code of [404, 403]) {
    const err: any = new Error('nope');
    err.response = { statusCode: code };
    assert.equal((await serviceWith(err).getCertificateStatus('ns', 'my-tls')).state, 'unknown');
  }
});

test('missing inputs short-circuit without calling the API', async () => {
  const svc = serviceWith(new Error('should not be reached'));
  assert.equal((await svc.getCertificateStatus('', 'my-tls')).state, 'unknown');
  assert.equal((await svc.getCertificateStatus('ns', null)).state, 'unknown');
});
