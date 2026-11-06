import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daemonTenantIngressPolicy,
  daemonTenantLabel,
  ingressAllows,
  LEGACY_DAEMON_INGRESS_POLICY
} from '../src/docker/buildkit-daemon-policy';
import { BuildKitPoolService } from '../src/docker/buildkit-pool.service';

const daemonLabels = (tenant: string) => ({
  'orchard.my/buildkit-daemon': 'true',
  'orchard.my/tenant-key': daemonTenantLabel(tenant),
  'app.kubernetes.io/name': 'buildkit-daemon'
});
const clientLabels = (tenant: string) => ({
  'app.kubernetes.io/name': 'image-builder',
  'orchard.my/tenant-key': daemonTenantLabel(tenant)
});

test('a daemon admits build pods of its own tenant only', () => {
  const policy = daemonTenantIngressPolicy({
    namespace: 'orchard-builders',
    name: 'p-a',
    tenantLabel: daemonTenantLabel('tenant-a')
  });
  assert.equal(
    ingressAllows(policy, daemonLabels('tenant-a'), clientLabels('tenant-a'), 1234),
    true
  );
  assert.equal(
    ingressAllows(policy, daemonLabels('tenant-a'), clientLabels('tenant-b'), 1234),
    false
  );
  assert.equal(
    ingressAllows(
      policy,
      daemonLabels('tenant-a'),
      { 'app.kubernetes.io/name': 'image-builder' },
      1234
    ),
    false
  );
  assert.equal(
    ingressAllows(policy, daemonLabels('tenant-b'), clientLabels('tenant-a'), 1234),
    false
  );
  assert.equal(
    ingressAllows(policy, daemonLabels('tenant-a'), clientLabels('tenant-a'), 9999),
    false
  );
});

test('pool writes a per-tenant policy, drops the broad one, and omits registry creds under sidecar push', async (t) => {
  t.mock.method(BuildKitPoolService.prototype as any, 'initKubeConfig', () => {});
  const policies = new Map<string, any>();
  const deleted: string[] = [];
  let pod: any;
  const networking = {
    deleteNamespacedNetworkPolicy: async (name: string) => {
      deleted.push(name);
      throw { statusCode: 404 };
    },
    readNamespacedNetworkPolicy: async () => {
      throw { statusCode: 404 };
    },
    createNamespacedNetworkPolicy: async (_ns: string, body: any) => {
      policies.set(body.metadata.name, body);
    }
  };
  const core = {
    listNamespacedPod: async () => ({ body: { items: [] } }),
    createNamespacedPod: async (_ns: string, body: any) => {
      pod = body;
    },
    readNamespacedPod: async () => ({
      body: {
        status: { phase: 'Running', podIP: '10.0.0.9', containerStatuses: [{ ready: true }] }
      }
    })
  };
  const pool = new BuildKitPoolService();
  Object.assign(pool, {
    kc: {
      makeApiClient: (api: { name: string }) => (api.name === 'CoreV1Api' ? core : networking)
    }
  });
  await pool.getOrCreateDaemon('Tenant-A');
  assert.deepEqual(deleted, [LEGACY_DAEMON_INGRESS_POLICY]);
  assert.equal(policies.size, 1);
  const [policy] = [...policies.values()];
  assert.equal(policy.spec.podSelector.matchLabels['orchard.my/tenant-key'], 'tenant-a');
  assert.equal(pod.metadata.labels['orchard.my/tenant-key'], 'tenant-a');
  assert.equal(
    pod.spec.volumes.some((v: any) => v.name === 'docker-config'),
    false
  );
  assert.equal(
    pod.spec.containers[0].volumeMounts.some((v: any) => v.name === 'docker-config'),
    false
  );
});
