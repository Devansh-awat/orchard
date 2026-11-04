import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import {
  namespaceRoom,
  tenantLimitRange,
  tenantQuotaFloor,
  tenantQuotaHard
} from '../src/kubernetes/tenant-quota';
import { K8sNamespaceService } from '../src/kubernetes/k8s-namespace.service';

const floor = tenantQuotaFloor({});

test('an uncapped namespace still gets a quota, never none', () => {
  const hard = tenantQuotaHard({}, floor);
  assert.equal(hard['pods'], '200');
  assert.equal(hard['services'], '100');
  assert.equal(hard['persistentvolumeclaims'], '50');
  assert.equal(hard['requests.storage'], String(500 * 1024 ** 3));
  assert.equal(hard['requests.cpu'], undefined);
  assert.equal(hard['requests.memory'], undefined);
});

test('explicit caps win over the floor and keep the cpu and memory lines', () => {
  const hard = tenantQuotaHard(
    { cpuLimitMilli: 4000, memoryLimitBytes: 8 * 1024 ** 3, maxPods: 20, maxServices: 5 },
    floor
  );
  assert.equal(hard['pods'], '20');
  assert.equal(hard['services'], '5');
  assert.equal(hard['requests.cpu'], '4000m');
  assert.equal(hard['limits.cpu'], '4000m');
  assert.equal(hard['requests.memory'], String(8 * 1024 ** 3));
  assert.equal(hard['persistentvolumeclaims'], '50');
});

test('the floor is tunable from the environment and ignores nonsense', () => {
  const custom = tenantQuotaFloor({
    TENANT_QUOTA_FLOOR_PODS: '10',
    TENANT_QUOTA_FLOOR_SERVICES: 'lots',
    TENANT_QUOTA_FLOOR_PVCS: '-3'
  });
  assert.equal(custom.pods, 10);
  assert.equal(custom.services, 100);
  assert.equal(custom.persistentvolumeclaims, 50);
});

test('zero or null caps fall back to the floor rather than removing the line', () => {
  const hard = tenantQuotaHard({ maxPods: 0, maxServices: null }, floor);
  assert.equal(hard['pods'], '200');
  assert.equal(hard['services'], '100');
});

const MiB = 1024 * 1024;
const orgDefault = { cpuMilli: 200, memoryBytes: 200 * MiB };
const capped = tenantQuotaHard({ cpuLimitMilli: 4000, memoryLimitBytes: 8 * 1024 ** 3 }, floor);

function namespaceServiceCalls() {
  const calls: { op: string; body?: any }[] = [];
  const api = {
    replaceNamespacedLimitRange: async (_n: string, _ns: string, body: any) => {
      calls.push({ op: 'limitRange', body: k8s.ObjectSerializer.serialize(body, 'V1LimitRange') });
    },
    replaceNamespacedResourceQuota: async (_n: string, _ns: string, body: any) => {
      calls.push({ op: 'quota', body });
    },
    deleteNamespacedLimitRange: async () => {
      calls.push({ op: 'deleteLimitRange' });
    }
  };
  const service = new K8sNamespaceService(
    {} as any,
    { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined } as any,
    {} as any
  );
  return { service, calls };
}

test('a capped namespace sends real default limits, and sends them before the quota', async () => {
  const { service, calls } = namespaceServiceCalls();
  await service.applyNamespaceQuota({
    namespace: 'p',
    cpuLimitMilli: 4000,
    memoryLimitBytes: 8 * 1024 ** 3,
    defaultPodCpuMilli: 200,
    defaultPodMemoryBytes: 200 * MiB,
    defaultLimit: orgDefault
  });
  assert.deepEqual(
    calls.map((c) => c.op),
    ['limitRange', 'quota']
  );
  const item = calls[0].body.spec.limits[0];
  assert.deepEqual(item.default, { cpu: '200m', memory: String(200 * MiB) });
  assert.deepEqual(item.defaultRequest, { cpu: '200m', memory: String(200 * MiB) });
});

test('a namespace with org defaults and no cap gets no default limit', async () => {
  const { service, calls } = namespaceServiceCalls();
  await service.applyNamespaceQuota({
    namespace: 'p',
    defaultPodCpuMilli: 200,
    defaultPodMemoryBytes: 200 * MiB
  });
  assert.equal(calls[0].body.spec.limits[0].default, undefined);
  assert.deepEqual(calls[0].body.spec.limits[0].defaultRequest, {
    cpu: '200m',
    memory: String(200 * MiB)
  });
});

test('the floor quota needs no limit, so an uncapped namespace adds none', () => {
  const range = tenantLimitRange(tenantQuotaHard({}, floor), orgDefault, orgDefault);
  assert.deepEqual(range.defaultLimit, {});
  assert.equal(tenantQuotaHard({}, floor)['limits.cpu'], undefined);
});

test('a default limit covers only the resources that the quota requires', () => {
  const memoryOnly = tenantQuotaHard({ memoryLimitBytes: 8 * 1024 ** 3 }, floor);
  assert.deepEqual(tenantLimitRange(memoryOnly, orgDefault, orgDefault).defaultLimit, {
    memory: String(200 * MiB)
  });
  assert.deepEqual(tenantLimitRange(capped, orgDefault, orgDefault).defaultLimit, {
    cpu: '200m',
    memory: String(200 * MiB)
  });
});

const deploymentWith = (resources: object, replicas?: number, annotations?: object) => ({
  kind: 'Deployment',
  manifest: {
    metadata: { annotations },
    spec: { replicas, template: { spec: { containers: [{ resources }] } } }
  }
});

test('an app without limits gets the organization default', () => {
  const room = namespaceRoom(
    [
      deploymentWith({ requests: { cpu: '50m', memory: '64Mi' } }, 2, {
        'orchard.my/no-limits': 'true'
      }),
      deploymentWith(
        { requests: { cpu: '100m', memory: '512Mi' }, limits: { cpu: '1', memory: '512Mi' } },
        1
      )
    ],
    orgDefault
  );
  assert.equal(room.hasWorkloadWithoutLimits, true);
  assert.deepEqual(room.defaultLimit, orgDefault);
  assert.equal(room.needed.memoryBytes, 2 * 200 * MiB + 512 * MiB);
  assert.equal(room.needed.cpuMilli, 2 * 200 + 1000);
});

test('an app someone set to unlimited does not raise the quota', () => {
  const room = namespaceRoom([deploymentWith({ requests: { cpu: '50m' } }, 20)], orgDefault);
  assert.equal(room.hasWorkloadWithoutLimits, false);
  assert.deepEqual(room.defaultLimit, orgDefault);
});

test('a default limit is never below what a pod without limits reserves', () => {
  const room = namespaceRoom(
    [deploymentWith({ requests: { cpu: '700m', memory: '900Mi' } })],
    orgDefault
  );
  assert.deepEqual(room.defaultLimit, { cpuMilli: 700, memoryBytes: 900 * MiB });
  const tiny = namespaceRoom([], { cpuMilli: 10, memoryBytes: 16 * MiB });
  assert.deepEqual(tiny.defaultLimit, { cpuMilli: 50, memoryBytes: 64 * MiB });
});

test('a database without limits keeps room for its shared_buffers and its backup', () => {
  const room = namespaceRoom(
    [
      {
        kind: 'Cluster',
        manifest: {
          spec: {
            instances: 1,
            resources: { requests: { cpu: '100m', memory: '320Mi' } },
            postgresql: { parameters: { shared_buffers: '256MB' } }
          }
        }
      }
    ],
    orgDefault
  );
  assert.equal(room.defaultLimit.memoryBytes, 1024 * MiB);
  const small = namespaceRoom(
    [
      {
        kind: 'Cluster',
        manifest: { spec: { instances: 1, resources: { requests: { memory: '256Mi' } } } }
      }
    ],
    orgDefault
  );
  assert.equal(small.defaultLimit.memoryBytes, 512 * MiB);
});

test('a limited database does not raise the default limit', () => {
  const room = namespaceRoom(
    [
      {
        kind: 'Cluster',
        manifest: {
          spec: {
            instances: 3,
            resources: { limits: { cpu: '2', memory: '4Gi' }, requests: { memory: '4Gi' } }
          }
        }
      }
    ],
    orgDefault
  );
  assert.equal(room.hasWorkloadWithoutLimits, false);
  assert.deepEqual(room.defaultLimit, orgDefault);
  assert.equal(room.needed.memoryBytes, 3 * 4096 * MiB);
});

test('a cron job counts once, and an unknown kind not at all', () => {
  const room = namespaceRoom(
    [
      {
        kind: 'CronJob',
        manifest: {
          spec: {
            jobTemplate: {
              spec: {
                template: { spec: { containers: [{ resources: { requests: { cpu: '50m' } } }] } }
              }
            }
          }
        }
      },
      { kind: 'Service', manifest: {} }
    ],
    orgDefault
  );
  assert.equal(room.needed.memoryBytes, 200 * MiB);
});
