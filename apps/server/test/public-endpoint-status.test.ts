import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBalancerMessage,
  NO_BALANCER_AFTER_MS,
  publicEndpointStatus,
  SERVICELB_NAME_LABEL,
  SERVICELB_NAMESPACE_LABEL
} from '../src/kubernetes/public-endpoint';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const UID = 'svc-uid-1';

function service(
  opts: {
    ingress?: { ip?: string; hostname?: string }[];
    requested?: string;
    createdAgoMs?: number;
    conditions?: any[];
    port?: number;
  } = {}
) {
  return {
    metadata: {
      name: 'web-pub-t31234',
      namespace: 'acme-prod',
      uid: UID,
      creationTimestamp: new Date(NOW - (opts.createdAgoMs ?? 10_000))
    },
    spec: {
      type: 'LoadBalancer',
      loadBalancerIP: opts.requested ?? '203.0.113.7',
      ports: [{ port: opts.port ?? 31234, protocol: 'TCP' }]
    },
    status: {
      loadBalancer: { ingress: opts.ingress ?? [] },
      ...(opts.conditions ? { conditions: opts.conditions } : {})
    }
  } as any;
}

function event(reason: string, message: string, type = 'Warning', uid = UID, agoMs = 5_000) {
  return {
    type,
    reason,
    message,
    involvedObject: { kind: 'Service', name: 'web-pub-t31234', uid },
    lastTimestamp: new Date(NOW - agoMs)
  } as any;
}

function svclbPod(scheduled: { status: string; reason?: string; message?: string }) {
  return {
    metadata: {
      name: 'svclb-web-pub-t31234-abcd1234-x7k2p',
      namespace: 'kube-system',
      labels: {
        [SERVICELB_NAME_LABEL]: 'web-pub-t31234',
        [SERVICELB_NAMESPACE_LABEL]: 'acme-prod'
      }
    },
    status: {
      phase: scheduled.status === 'True' ? 'Running' : 'Pending',
      conditions: [{ type: 'PodScheduled', ...scheduled }]
    }
  } as any;
}

test('ready when the requested address is assigned', () => {
  const status = publicEndpointStatus({
    service: service({ ingress: [{ ip: '203.0.113.7' }] }),
    events: [event('AllocationFailed', 'old failure', 'Warning', 'previous-uid')],
    balancerPods: [],
    now: NOW
  });
  assert.deepEqual(status, { state: 'ready', addresses: ['203.0.113.7'], reason: null });
});

test('ready on k3s servicelb, which reports node addresses instead of the requested one', () => {
  const status = publicEndpointStatus({
    service: service({ ingress: [{ ip: '10.0.0.4' }] }),
    events: [],
    balancerPods: [svclbPod({ status: 'True' })],
    now: NOW
  });
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.addresses, ['10.0.0.4']);
});

test('failed when another balancer assigned a different address than Orchard shows', () => {
  const status = publicEndpointStatus({
    service: service({ ingress: [{ hostname: 'abc.elb.amazonaws.com' }] }),
    events: [],
    balancerPods: [],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.equal(
    status.reason,
    'The load balancer assigned abc.elb.amazonaws.com instead of 203.0.113.7.'
  );
});

test('pending while nothing is assigned and nothing failed', () => {
  const status = publicEndpointStatus({
    service: service(),
    events: [event('EnsuringLoadBalancer', 'Ensuring load balancer', 'Normal')],
    balancerPods: [],
    now: NOW
  });
  assert.deepEqual(status, { state: 'pending', addresses: [], reason: null });
});

test('pending while the servicelb pod is still starting', () => {
  const status = publicEndpointStatus({
    service: service(),
    events: [],
    balancerPods: [svclbPod({ status: 'True' })],
    now: NOW
  });
  assert.equal(status.state, 'pending');
});

test('failed when klipper cannot bind the host port', () => {
  const status = publicEndpointStatus({
    service: service({ port: 31234 }),
    events: [],
    balancerPods: [
      svclbPod({
        status: 'False',
        reason: 'Unschedulable',
        message:
          "0/1 nodes are available: 1 node(s) didn't have free ports for the requested pod ports. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod."
      })
    ],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.equal(
    status.reason,
    'Port 31234 is already in use on the server, so the load balancer cannot listen on it.'
  );
});

test('failed with the scheduler reason when the servicelb pod cannot be placed for another reason', () => {
  const status = publicEndpointStatus({
    service: service(),
    events: [],
    balancerPods: [
      svclbPod({
        status: 'False',
        reason: 'Unschedulable',
        message: '0/2 nodes are available: 2 node(s) had untolerated taint {dedicated: db}.'
      })
    ],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.match(status.reason ?? '', /^The load balancer cannot start: 0\/2 nodes are available/);
});

test('failed with the cloud controller message', () => {
  const status = publicEndpointStatus({
    service: service(),
    events: [
      event(
        'SyncLoadBalancerFailed',
        'Error syncing load balancer: failed to ensure load balancer: QuotaExceeded: Quota IN_USE_ADDRESSES exceeded. Limit: 8.0 in region europe-west1.'
      )
    ],
    balancerPods: [],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.equal(
    status.reason,
    'The load balancer could not be created: QuotaExceeded: Quota IN_USE_ADDRESSES exceeded. Limit: 8.0 in region europe-west1.'
  );
});

test('failed when MetalLB cannot allocate the requested address', () => {
  const status = publicEndpointStatus({
    service: service(),
    events: [
      event(
        'AllocationFailed',
        'Failed to allocate IP for "acme-prod/web-pub-t31234": "203.0.113.7" is not allowed in config'
      )
    ],
    balancerPods: [],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.equal(
    status.reason,
    'No address could be allocated: "203.0.113.7" is not allowed in config.'
  );
});

test('failed when Cilium reports the request unsatisfied', () => {
  const status = publicEndpointStatus({
    service: service({
      conditions: [
        {
          type: 'io.cilium/IPAMRequestSatisfied',
          status: 'False',
          reason: 'no_pool',
          message: 'There are no enabled CiliumLoadBalancerIPPools that match this service'
        }
      ]
    }),
    events: [],
    balancerPods: [],
    now: NOW
  });
  assert.equal(status.state, 'failed');
  assert.equal(
    status.reason,
    'No address could be assigned: there are no enabled CiliumLoadBalancerIPPools that match this service.'
  );
});

test('failed when nothing picks the request up for five minutes', () => {
  const fresh = publicEndpointStatus({
    service: service({ createdAgoMs: NO_BALANCER_AFTER_MS - 1_000 }),
    events: [],
    balancerPods: [],
    now: NOW
  });
  assert.equal(fresh.state, 'pending');
  const stale = publicEndpointStatus({
    service: service({ createdAgoMs: NO_BALANCER_AFTER_MS + 1_000 }),
    events: [],
    balancerPods: [],
    now: NOW
  });
  assert.equal(stale.state, 'failed');
  assert.equal(stale.reason, 'No load balancer assigned an address after 5 minutes.');
});

test('failed when the Service is gone', () => {
  const status = publicEndpointStatus({ service: null, events: [], balancerPods: [], now: NOW });
  assert.equal(status.state, 'failed');
});

test('cleanBalancerMessage trims, strips prefixes and caps length', () => {
  assert.equal(cleanBalancerMessage(''), '');
  assert.equal(cleanBalancerMessage('  no free addresses  '), 'No free addresses.');
  const long = cleanBalancerMessage('x'.repeat(500));
  assert.ok(long.length <= 221);
  assert.ok(long.endsWith('…'));
});

function networkWith(core: Record<string, (...args: any[]) => Promise<any>>) {
  const kc = { makeApiClient: () => core };
  const kubernetes = { kc, ensureKubeConfig: () => undefined };
  return new K8sNetworkService({} as any, kubernetes as any, {} as any);
}

test('a failed read is unknown, never failed', async () => {
  const net = networkWith({
    readNamespacedService: async () => {
      throw Object.assign(new Error('HTTP request failed'), {
        name: 'HttpError',
        statusCode: 503
      });
    },
    listNamespacedEvent: async () => ({ body: { items: [] } }),
    listPodForAllNamespaces: async () => ({ body: { items: [] } })
  });
  const statuses = await net.publicEndpointStatuses('acme-prod', ['web-pub-t31234']);
  assert.deepEqual(statuses.get('web-pub-t31234'), {
    state: 'unknown',
    addresses: [],
    reason: null
  });
});

test('no kubeconfig is unknown', async () => {
  const kubernetes = {
    kc: null,
    ensureKubeConfig: () => {
      throw new Error('Kubernetes API not available');
    }
  };
  const net = new K8sNetworkService({} as any, kubernetes as any, {} as any);
  const statuses = await net.publicEndpointStatuses('acme-prod', ['web-pub-t31234']);
  assert.equal(statuses.get('web-pub-t31234')?.state, 'unknown');
});

test('a live 404 is failed, and statuses are read per Service', async () => {
  const net = networkWith({
    readNamespacedService: async (name: string) => {
      if (name === 'gone') {
        throw Object.assign(new Error('HTTP request failed'), {
          name: 'HttpError',
          statusCode: 404
        });
      }
      return { body: service({ ingress: [{ ip: '203.0.113.7' }] }) };
    },
    listNamespacedEvent: async () => ({ body: { items: [] } }),
    listPodForAllNamespaces: async () => ({ body: { items: [] } })
  });
  const statuses = await net.publicEndpointStatuses('acme-prod', ['web-pub-t31234', 'gone']);
  assert.equal(statuses.get('web-pub-t31234')?.state, 'ready');
  assert.equal(statuses.get('gone')?.state, 'failed');
});
