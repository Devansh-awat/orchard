import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUSE_LIMIT_RANGE_NAME,
  ABUSE_QUOTA_NAME,
  abuseCaps,
  abuseLimitRange,
  abuseQuota,
  abuseQuotaHard
} from '../src/kubernetes/tenant-abuse-quota';
import { K8sNamespaceService } from '../src/kubernetes/k8s-namespace.service';

const GiB = 1024 ** 3;

test('defaults bound load balancers, node ports and ephemeral storage', () => {
  const caps = abuseCaps({});
  assert.deepEqual(caps, { loadBalancers: 20, nodePorts: 10, ephemeralLimitBytes: 20 * GiB });
  const hard = abuseQuotaHard(caps);
  assert.equal(hard['services.loadbalancers'], '20');
  assert.equal(hard['services.nodeports'], '10');
  assert.equal(hard['requests.ephemeral-storage'], String(500 * GiB));
  assert.equal(hard['limits.ephemeral-storage'], String(20 * GiB * 1000));
});

test('node ports can be switched off for a tenant fleet that does not publish ports', () => {
  assert.equal(
    abuseQuotaHard(abuseCaps({ TENANT_QUOTA_FLOOR_NODEPORTS: '0' }))['services.nodeports'],
    '0'
  );
  assert.equal(abuseCaps({ TENANT_QUOTA_FLOOR_LOADBALANCERS: 'many' }).loadBalancers, 20);
  assert.equal(abuseCaps({ TENANT_QUOTA_FLOOR_NODEPORTS: '-1' }).nodePorts, 10);
});

test('the container defaults give every pod an ephemeral-storage request and limit', () => {
  const range = abuseLimitRange(abuseCaps({}))!;
  assert.equal(range.metadata!.name, ABUSE_LIMIT_RANGE_NAME);
  const item = range.spec!.limits[0];
  assert.equal(item.type, 'Container');
  assert.equal(item._default!['ephemeral-storage'], String(20 * GiB));
  assert.equal(item.defaultRequest!['ephemeral-storage'], String(128 * 1024 ** 2));
});

test('a zero ephemeral limit turns the ephemeral part off and keeps the service counts', () => {
  const caps = abuseCaps({ TENANT_EPHEMERAL_STORAGE_LIMIT_GIB: '0' });
  assert.equal(abuseLimitRange(caps), null);
  const hard = abuseQuota(caps).spec!.hard!;
  assert.deepEqual(Object.keys(hard).sort(), ['services.loadbalancers', 'services.nodeports']);
});

function service() {
  const calls: { op: string; name: string }[] = [];
  const api = {
    replaceNamespacedLimitRange: async (name: string) => {
      calls.push({ op: 'replaceLimitRange', name });
      throw Object.assign(new Error('missing'), { response: { statusCode: 404 } });
    },
    createNamespacedLimitRange: async (_ns: string, body: any) => {
      calls.push({ op: 'createLimitRange', name: body.metadata.name });
    },
    replaceNamespacedResourceQuota: async (name: string) => {
      calls.push({ op: 'replaceQuota', name });
    },
    createNamespacedResourceQuota: async () => {
      calls.push({ op: 'createQuota', name: '' });
    }
  };
  const instance = new K8sNamespaceService(
    {} as any,
    { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined } as any,
    {} as any
  );
  return { instance, calls };
}

test('the guards are created next to, not in place of, the capped quota, limit range first', async () => {
  const { instance, calls } = service();
  await instance.applyAbuseGuards('acme-web');
  assert.deepEqual(calls, [
    { op: 'replaceLimitRange', name: ABUSE_LIMIT_RANGE_NAME },
    { op: 'createLimitRange', name: ABUSE_LIMIT_RANGE_NAME },
    { op: 'replaceQuota', name: ABUSE_QUOTA_NAME }
  ]);
});
