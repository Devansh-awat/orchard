import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { DoctorService, httpProbe, requestFact } from '../src/doctor/doctor.service';
import { DoctorController } from '../src/doctor/doctor.controller';
import { CHECK_IDS, EXPECTED_POLICIES } from '../src/doctor/doctor.checks';
import type { ClusterReader } from '../src/doctor/cluster-reader';
import { REQUIRES_SUPERADMIN_KEY } from '../src/auth/decorators';

function reader(overrides: Partial<ClusterReader> = {}): ClusterReader {
  return {
    apiGroups: async () => ['cilium.io'],
    daemonSets: async () => [{ name: 'cilium', namespace: 'kube-system', desired: 1, ready: 1 }],
    nodes: async () => [{ name: 'n1', kubelet: 'v1.31.0' }],
    managedNamespaces: async () => [
      { name: 'a-b-111111', labels: { 'pod-security.kubernetes.io/enforce': 'baseline' } }
    ],
    denyPolicyNamespaces: async () => ['a-b-111111'],
    quotas: async () => ({ 'a-b-111111': ['orchard-org-quota', 'orchard-abuse-quota'] }),
    runtimeClassExists: async () => true,
    admission: async () => ({
      policies: EXPECTED_POLICIES,
      bindings: EXPECTED_POLICIES.map((n) => ({ name: n, policyName: n, actions: ['Deny'] }))
    }),
    priorityClassExists: async () => true,
    clusterIssuer: async () => ({ exists: true, ready: true }),
    ...overrides
  };
}

function service(r: ClusterReader | null, fetcher?: typeof fetch) {
  const selftest: any = { latestFinished: () => null };
  const settings: any = { isCustomDomainVerificationRequired: async () => true };
  const svc: any = new DoctorService({ kc: null } as any, settings, selftest);
  svc.reader = () => r;
  if (fetcher) svc.fetcher = fetcher;
  return svc as DoctorService;
}

const env = {
  JWT_SECRET: 'q8Zr2LmN5vXcB7tYhP3wKd9fGaJ4sUeV1oIxC6nMbQ0',
  SECRETS_ENCRYPTION_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182',
  REDIS_URL: 'redis://:pw@redis:6379'
};

const okFetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

test('gather feeds the pure checks from the cluster reader and settings', async () => {
  const svc = service(reader(), okFetch);
  const inputs = await svc.gather(null, env);
  assert.equal(inputs.namespaces.ok, true);
  assert.equal(inputs.tenantRuntimeClass, null);
  assert.equal(inputs.settings.ok && inputs.settings.value.customDomainVerification, true);
  assert.equal(inputs.metrics.ok && inputs.metrics.value.ok, true);
});

test('only configured runtime classes are looked up', async () => {
  const asked: string[] = [];
  const svc = service(
    reader({
      runtimeClassExists: async (name) => {
        asked.push(name);
        return name === 'gvisor';
      }
    }),
    okFetch
  );
  const inputs = await svc.gather(null, {
    ...env,
    TENANT_RUNTIME_CLASS: 'gvisor',
    BUILDER_RUNTIME_CLASS: 'kata'
  });
  assert.deepEqual(asked.sort(), ['gvisor', 'kata']);
  assert.deepEqual(inputs.builderRuntimeClass, { ok: true, value: false });
});

test('a reader call that throws becomes an unreadable fact, the rest still resolve', async () => {
  const svc = service(
    reader({
      managedNamespaces: async () => {
        throw Object.assign(new Error('namespaces is forbidden'), {
          response: { statusCode: 403 }
        });
      }
    }),
    okFetch
  );
  const report = await svc.report(null);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId['default-deny-coverage'].status, 'unknown');
  assert.match(byId['default-deny-coverage'].evidence, /403/);
  assert.equal(byId['priority-class'].status, 'pass');
  assert.equal(report.checks.length, CHECK_IDS.length);
  assert.equal(
    report.summary.pass + report.summary.warn + report.summary.fail + report.summary.unknown,
    CHECK_IDS.length
  );
});

test('without a kubeconfig every cluster check is unknown rather than failing the report', async () => {
  const report = await service(null, okFetch).report(null);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  for (const id of [
    'cni-enforcement',
    'default-deny-coverage',
    'admission-policies',
    'namespace-quotas'
  ]) {
    assert.equal(byId[id].status, 'unknown', id);
  }
  assert.equal(report.selftest, null);
});

test('the report includes the latest self-test summary when one exists', async () => {
  const svc: any = service(reader(), okFetch);
  svc.selftest = {
    latestFinished: () => ({
      id: 'st-1',
      finishedAt: '2026-01-01T00:00:00.000Z',
      summary: { pass: 1, warn: 0, fail: 0, unknown: 0 },
      checks: [{ id: 'selftest-nodes', status: 'pass' }]
    })
  };
  const report = await svc.report(null);
  assert.equal(report.selftest?.id, 'st-1');
});

test('http probes report failures and server errors as not ok', async () => {
  const refused = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  assert.equal((await httpProbe('http://vm:8428/health', refused)).ok, false);
  assert.equal((await httpProbe('http://vm:8428/health', down)).ok, false);
  const up = await httpProbe('http://vm:8428/health', okFetch);
  assert.equal(up.ok, true);
  assert.match(up.detail, /vm:8428/);
});

test('request facts carry the socket peer and the resolved client address', () => {
  const fact = requestFact({
    headers: { 'x-forwarded-for': '198.51.100.7' },
    socket: { remoteAddress: '10.0.0.4' },
    ip: '10.0.0.4'
  } as any);
  assert.equal(fact?.socketAddress, '10.0.0.4');
  assert.equal(fact?.forwardedFor, '198.51.100.7');
  assert.equal(requestFact(null), null);
});

test('the doctor routes are superadmin only', () => {
  assert.equal(Reflect.getMetadata(REQUIRES_SUPERADMIN_KEY, DoctorController), true);
});
