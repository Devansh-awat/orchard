import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_IDS,
  EXPECTED_POLICIES,
  admissionCheck,
  backupProxyCheck,
  builderPostureCheck,
  certIssuerCheck,
  clientIpCheck,
  cniCheck,
  defaultDenyCheck,
  evaluateAll,
  hostnameStyleCheck,
  jwtSecretCheck,
  logsCheck,
  metricsCheck,
  nodePortCheck,
  podSecurityCheck,
  priorityClassCheck,
  quotaCheck,
  redisCheck,
  registryPolicyCheck,
  secretsKeyCheck,
  signupCheck,
  tenantRuntimeCheck,
  type DoctorInputs
} from '../src/doctor/doctor.checks';
import { summarize } from '../src/doctor/doctor.types';

const ok = <T>(value: T) => ({ ok: true as const, value });
const bad = { ok: false as const, error: '403: forbidden' };

const GOOD_ENV = {
  JWT_SECRET: 'q8Zr2LmN5vXcB7tYhP3wKd9fGaJ4sUeV1oIxC6nMbQ0',
  SECRETS_ENCRYPTION_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182',
  REDIS_URL: 'redis://:s3cret@redis.orchard.svc:6379',
  TENANT_RUNTIME_CLASS: 'gvisor',
  BUILDER_RUNTIME_CLASS: 'kata',
  TENANT_NODEPORT_EXPOSURE: 'false',
  DOCKER_REGISTRY_PULL: 'registry.example.com',
  SIGNUP_MODE: 'invite_only',
  BACKUP_PROXY_ENABLED: 'true'
};

function inputs(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    env: { ...GOOD_ENV },
    request: { socketAddress: '203.0.113.9', forwardedFor: null, resolved: '203.0.113.9' },
    apiGroups: ok(['cilium.io']),
    daemonSets: ok([{ name: 'cilium', namespace: 'kube-system', desired: 3, ready: 3 }]),
    nodes: ok([{ name: 'n1', kubelet: 'v1.31.0' }]),
    namespaces: ok([
      {
        name: 'acme-web-a1b2c3',
        labels: { 'pod-security.kubernetes.io/enforce': 'baseline' }
      }
    ]),
    denyPolicies: ok(['acme-web-a1b2c3']),
    quotas: ok({ 'acme-web-a1b2c3': ['orchard-org-quota', 'orchard-abuse-quota'] }),
    tenantRuntimeClass: ok(true),
    builderRuntimeClass: ok(true),
    admission: ok({
      policies: [...EXPECTED_POLICIES, 'orchard-tenant-images'],
      bindings: [
        ...EXPECTED_POLICIES.map((name) => ({ name, policyName: name, actions: ['Deny'] })),
        { name: 'orchard-tenant-images', policyName: 'orchard-tenant-images', actions: ['Deny'] }
      ]
    }),
    priorityClass: ok(true),
    issuer: ok({ exists: true, ready: true }),
    settings: ok({ signupMode: 'invite_only', customDomainVerification: true }),
    metrics: ok({ ok: true, detail: 'HTTP 200' }),
    logs: ok({ ok: true, detail: 'HTTP 200' }),
    ...overrides
  };
}

const withEnv = (env: Record<string, string | undefined>, rest: Partial<DoctorInputs> = {}) =>
  inputs({ env: { ...GOOD_ENV, ...env }, ...rest });

test('a healthy install passes every passive check except the unverifiable proxy list', () => {
  const checks = evaluateAll(inputs());
  assert.deepEqual(
    checks.map((c) => c.id),
    CHECK_IDS
  );
  for (const c of checks) {
    if (c.id === 'backup-proxy-buckets') assert.equal(c.status, 'unknown');
    else assert.equal(c.status, 'pass', `${c.id}: ${c.evidence}`);
  }
  for (const c of checks) {
    assert.ok(c.title && c.evidence);
    assert.match(c.docs, /\/operate\/doctor\/#/);
  }
});

test('every check turns an unreadable fact into unknown and never throws', () => {
  const broken = inputs({
    apiGroups: bad,
    daemonSets: bad,
    namespaces: bad,
    denyPolicies: bad,
    quotas: bad,
    tenantRuntimeClass: bad,
    builderRuntimeClass: bad,
    admission: bad,
    priorityClass: bad,
    issuer: bad,
    settings: bad,
    metrics: bad,
    logs: bad
  });
  const byId = Object.fromEntries(evaluateAll(broken).map((c) => [c.id, c]));
  for (const id of [
    'cni-enforcement',
    'default-deny-coverage',
    'tenant-runtime-class',
    'builder-posture',
    'pod-security-labels',
    'admission-policies',
    'namespace-quotas',
    'priority-class',
    'cert-issuer',
    'signup-and-domain-verification',
    'registry-image-policy',
    'metrics-stack',
    'logging-stack'
  ]) {
    assert.equal(byId[id].status, 'unknown', id);
    assert.match(byId[id].evidence, /403/, id);
  }
});

test('an evaluator that throws is reported as unknown, not propagated', () => {
  const poisoned = inputs();
  Object.defineProperty(poisoned, 'env', {
    get() {
      throw new Error('boom');
    }
  });
  const checks = evaluateAll(poisoned);
  assert.ok(checks.some((c) => c.status === 'unknown' && /itself failed/.test(c.evidence)));
});

test('cni: enforcing CNI passes, unready agents warn, flannel warns, k3s and nothing are unknown', () => {
  assert.equal(cniCheck(inputs()).status, 'pass');
  assert.equal(
    cniCheck(
      inputs({
        apiGroups: ok([]),
        daemonSets: ok([{ name: 'calico-node', namespace: 'calico-system', desired: 3, ready: 3 }])
      })
    ).evidence.includes('Calico'),
    true
  );
  const unready = cniCheck(
    inputs({ daemonSets: ok([{ name: 'cilium', namespace: 'kube-system', desired: 3, ready: 1 }]) })
  );
  assert.equal(unready.status, 'warn');
  const flannel = cniCheck(
    inputs({
      apiGroups: ok([]),
      daemonSets: ok([{ name: 'kube-flannel-ds', namespace: 'kube-flannel', desired: 1, ready: 1 }])
    })
  );
  assert.equal(flannel.status, 'warn');
  assert.match(flannel.fix, /networkPolicy\.enforcer\.enabled=true/);
  const k3s = cniCheck(
    inputs({
      apiGroups: ok([]),
      daemonSets: ok([]),
      nodes: ok([{ name: 'n1', kubelet: 'v1.30.2+k3s1' }])
    })
  );
  assert.equal(k3s.status, 'unknown');
  const none = cniCheck(inputs({ apiGroups: ok([]), daemonSets: ok([]) }));
  assert.equal(none.status, 'unknown');
  assert.match(none.fix, /self-test/);
});

test('cni: the chart enforcer next to flannel passes, next to another enforcer warns', () => {
  const enforcer = { name: 'kube-router', namespace: 'orchard-netpol', desired: 3, ready: 3 };
  const flannel = { name: 'kube-flannel', namespace: 'kube-system', desired: 3, ready: 3 };
  const talos = cniCheck(
    inputs({
      apiGroups: ok([]),
      daemonSets: ok([flannel, enforcer]),
      nodes: ok([{ name: 'n1', kubelet: 'v1.34.1' }])
    })
  );
  assert.equal(talos.status, 'pass');
  assert.match(talos.evidence, /kube-router/);
  const starting = cniCheck(
    inputs({
      apiGroups: ok([]),
      daemonSets: ok([flannel, { ...enforcer, ready: 2 }])
    })
  );
  assert.equal(starting.status, 'warn');
  assert.match(starting.evidence, /orchard-netpol\/kube-router 2\/3/);
  const doubled = cniCheck(inputs({ daemonSets: ok([enforcer]) }));
  assert.equal(doubled.status, 'warn');
  assert.match(doubled.evidence, /next to Cilium/);
  assert.match(doubled.fix, /networkPolicy\.enforcer\.enabled=false/);
  const onK3s = cniCheck(
    inputs({
      apiGroups: ok([]),
      daemonSets: ok([enforcer]),
      nodes: ok([{ name: 'n1', kubelet: 'v1.34.1+k3s1' }])
    })
  );
  assert.equal(onK3s.status, 'warn');
  assert.match(onK3s.evidence, /k3s/);
});

test('cni: group CRDs alone count, and one unreadable source still allows a verdict', () => {
  assert.equal(cniCheck(inputs({ daemonSets: bad })).status, 'pass');
  assert.equal(cniCheck(inputs({ apiGroups: bad })).status, 'pass');
  assert.equal(cniCheck(inputs({ apiGroups: bad, daemonSets: bad })).status, 'unknown');
});

test('default-deny: counts namespaces without the policy', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `ns-${i}`, labels: {} }));
  const missing = defaultDenyCheck(
    inputs({ namespaces: ok(many), denyPolicies: ok(['ns-0', 'ns-1']) })
  );
  assert.equal(missing.status, 'fail');
  assert.match(missing.evidence, /5 of 7/);
  assert.match(missing.evidence, /and 0 more|ns-2/);
  assert.equal(
    defaultDenyCheck(inputs({ namespaces: ok([]), denyPolicies: ok([]) })).status,
    'pass'
  );
  assert.equal(defaultDenyCheck(inputs()).status, 'pass');
});

test('tenant runtime class: unset warns, missing object fails, present passes', () => {
  assert.equal(tenantRuntimeCheck(withEnv({ TENANT_RUNTIME_CLASS: '' })).status, 'warn');
  assert.equal(tenantRuntimeCheck(inputs({ tenantRuntimeClass: ok(false) })).status, 'fail');
  assert.equal(tenantRuntimeCheck(inputs()).status, 'pass');
  assert.equal(tenantRuntimeCheck(inputs({ tenantRuntimeClass: bad })).status, 'unknown');
  assert.equal(tenantRuntimeCheck(inputs({ tenantRuntimeClass: null })).status, 'unknown');
});

test('builder posture: vm-sandbox passes, rootless warns, privileged host fails', () => {
  assert.equal(builderPostureCheck(inputs()).status, 'pass');
  assert.equal(builderPostureCheck(inputs({ builderRuntimeClass: ok(false) })).status, 'fail');
  assert.equal(builderPostureCheck(withEnv({ BUILDER_RUNTIME_CLASS: '' })).status, 'warn');
  assert.equal(
    builderPostureCheck(
      withEnv({ BUILDER_RUNTIME_CLASS: '', BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'true' })
    ).status,
    'fail'
  );
});

test('pod security labels: a namespace without enforce fails', () => {
  const weak = podSecurityCheck(
    inputs({
      namespaces: ok([
        { name: 'a', labels: { 'pod-security.kubernetes.io/enforce': 'privileged' } },
        { name: 'b', labels: {} },
        { name: 'c', labels: { 'pod-security.kubernetes.io/enforce': 'restricted' } }
      ])
    })
  );
  assert.equal(weak.status, 'fail');
  assert.match(weak.evidence, /2 of 3/);
  assert.equal(podSecurityCheck(inputs()).status, 'pass');
});

test('admission policies: none warns, partial fails, warn-only warns, all Deny passes', () => {
  assert.equal(
    admissionCheck(inputs({ admission: ok({ policies: [], bindings: [] }) })).status,
    'warn'
  );
  assert.equal(
    admissionCheck(
      inputs({
        admission: ok({
          policies: EXPECTED_POLICIES.slice(0, 3),
          bindings: EXPECTED_POLICIES.slice(0, 3).map((n) => ({
            name: n,
            policyName: n,
            actions: ['Deny']
          }))
        })
      })
    ).status,
    'fail'
  );
  const soft = admissionCheck(
    inputs({
      admission: ok({
        policies: EXPECTED_POLICIES,
        bindings: EXPECTED_POLICIES.map((n) => ({
          name: n,
          policyName: n,
          actions: ['Warn', 'Audit']
        }))
      })
    })
  );
  assert.equal(soft.status, 'warn');
  assert.match(soft.evidence, /10 of 10/);
  assert.equal(admissionCheck(inputs()).status, 'pass');
});

test('redis: password passes, none warns, unset warns, junk warns', () => {
  assert.equal(redisCheck(inputs()).status, 'pass');
  assert.equal(redisCheck(withEnv({ REDIS_URL: 'redis://redis:6379' })).status, 'warn');
  assert.equal(
    redisCheck(withEnv({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'x' })).status,
    'pass'
  );
  assert.equal(redisCheck(withEnv({ REDIS_URL: undefined })).status, 'warn');
  assert.equal(redisCheck(withEnv({ REDIS_URL: 'not a url' })).status, 'warn');
  assert.ok(!redisCheck(inputs()).evidence.includes('s3cret'));
});

test('secrets key: missing fails, sso fallback and short warn, good passes', () => {
  assert.equal(secretsKeyCheck(withEnv({ SECRETS_ENCRYPTION_KEY: undefined })).status, 'fail');
  assert.equal(
    secretsKeyCheck(withEnv({ SECRETS_ENCRYPTION_KEY: '', SSO_ENCRYPTION_KEY: 'x'.repeat(40) }))
      .status,
    'warn'
  );
  assert.equal(secretsKeyCheck(withEnv({ SECRETS_ENCRYPTION_KEY: 'short' })).status, 'warn');
  assert.equal(secretsKeyCheck(inputs()).status, 'pass');
});

test('jwt secret: unset, short, example, low variety fail; reuse warns; never echoes the value', () => {
  assert.equal(jwtSecretCheck(withEnv({ JWT_SECRET: undefined })).status, 'fail');
  assert.equal(jwtSecretCheck(withEnv({ JWT_SECRET: 'tooshort' })).status, 'fail');
  assert.equal(
    jwtSecretCheck(withEnv({ JWT_SECRET: 'changeme-' + 'abcdefghijklmnop'.repeat(2) })).status,
    'fail'
  );
  assert.equal(jwtSecretCheck(withEnv({ JWT_SECRET: 'ab'.repeat(30) })).status, 'fail');
  assert.equal(
    jwtSecretCheck(withEnv({ SECRETS_ENCRYPTION_KEY: GOOD_ENV.JWT_SECRET })).status,
    'warn'
  );
  const good = jwtSecretCheck(inputs());
  assert.equal(good.status, 'pass');
  assert.ok(!good.evidence.includes(GOOD_ENV.JWT_SECRET));
});

test('client ip: private peer with forwarded header and no trust warns', () => {
  const collapsed = clientIpCheck(
    inputs({
      request: { socketAddress: '10.0.3.4', forwardedFor: '198.51.100.7', resolved: '10.0.3.4' }
    })
  );
  assert.equal(collapsed.status, 'warn');
  assert.match(collapsed.evidence, /10\.0\.3\.4/);
});

test('client ip: configured trust resolving a public client passes', () => {
  const trusted = clientIpCheck(
    withEnv(
      { TRUST_PROXY: '1' },
      {
        request: {
          socketAddress: '10.0.3.4',
          forwardedFor: '198.51.100.7',
          resolved: '198.51.100.7'
        }
      }
    )
  );
  assert.equal(trusted.status, 'pass');
});

test('client ip: trust configured but still collapsed warns; junk TRUST_PROXY warns; no request is unknown', () => {
  assert.equal(
    clientIpCheck(
      withEnv(
        { TRUST_PROXY: '1' },
        { request: { socketAddress: '10.0.3.4', forwardedFor: '10.9.9.9', resolved: '10.9.9.9' } }
      )
    ).status,
    'warn'
  );
  assert.equal(clientIpCheck(withEnv({ TRUST_PROXY: 'true' })).status, 'warn');
  assert.equal(clientIpCheck(inputs({ request: null })).status, 'unknown');
  assert.equal(
    clientIpCheck(
      inputs({ request: { socketAddress: '10.0.3.4', forwardedFor: null, resolved: '10.0.3.4' } })
    ).status,
    'unknown'
  );
  assert.equal(clientIpCheck(inputs()).status, 'pass');
});

test('signup: open without verification fails, open with it warns, closed passes', () => {
  assert.equal(
    signupCheck(inputs({ settings: ok({ signupMode: 'open', customDomainVerification: false }) }))
      .status,
    'fail'
  );
  assert.equal(
    signupCheck(inputs({ settings: ok({ signupMode: 'open', customDomainVerification: true }) }))
      .status,
    'warn'
  );
  assert.equal(
    signupCheck(inputs({ settings: ok({ signupMode: 'closed', customDomainVerification: false }) }))
      .status,
    'pass'
  );
});

test('registry policy: off fails, no registry or no policy or warn-only warns, deny passes', () => {
  assert.equal(registryPolicyCheck(withEnv({ REGISTRY_IMAGE_POLICY: 'off' })).status, 'fail');
  assert.equal(registryPolicyCheck(withEnv({ DOCKER_REGISTRY_PULL: undefined })).status, 'warn');
  assert.equal(
    registryPolicyCheck(inputs({ admission: ok({ policies: [], bindings: [] }) })).status,
    'warn'
  );
  assert.equal(
    registryPolicyCheck(
      inputs({
        admission: ok({
          policies: ['orchard-tenant-images'],
          bindings: [
            {
              name: 'orchard-tenant-images',
              policyName: 'orchard-tenant-images',
              actions: ['Warn', 'Audit']
            }
          ]
        })
      })
    ).status,
    'warn'
  );
  assert.equal(registryPolicyCheck(inputs()).status, 'pass');
  assert.equal(registryPolicyCheck(inputs({ admission: bad })).status, 'unknown');
});

test('nodeport and hostname style', () => {
  assert.equal(nodePortCheck(withEnv({ TENANT_NODEPORT_EXPOSURE: undefined })).status, 'warn');
  assert.equal(nodePortCheck(inputs()).status, 'pass');
  assert.equal(hostnameStyleCheck(withEnv({ HOSTNAME_STYLE: 'readable' })).status, 'warn');
  assert.equal(hostnameStyleCheck(inputs()).status, 'pass');
});

test('quotas: none fails, partial warns with counts, full passes', () => {
  const namespaces = ok([
    { name: 'a', labels: {} },
    { name: 'b', labels: {} },
    { name: 'c', labels: {} }
  ]);
  const none = quotaCheck(
    inputs({ namespaces, quotas: ok({ a: ['orchard-org-quota', 'orchard-abuse-quota'] }) })
  );
  assert.equal(none.status, 'fail');
  assert.match(none.evidence, /2 of 3/);
  const partial = quotaCheck(
    inputs({
      namespaces,
      quotas: ok({
        a: ['orchard-org-quota', 'orchard-abuse-quota'],
        b: ['orchard-abuse-quota'],
        c: ['orchard-org-quota']
      })
    })
  );
  assert.equal(partial.status, 'warn');
  assert.equal(quotaCheck(inputs()).status, 'pass');
});

test('priority class, cert issuer, backup proxy, metrics and logs', () => {
  assert.equal(priorityClassCheck(inputs({ priorityClass: ok(false) })).status, 'warn');
  assert.equal(priorityClassCheck(inputs()).status, 'pass');
  assert.equal(
    certIssuerCheck(inputs({ issuer: ok({ exists: false, ready: null }) })).status,
    'fail'
  );
  assert.equal(
    certIssuerCheck(inputs({ issuer: ok({ exists: true, ready: false }) })).status,
    'fail'
  );
  assert.equal(
    certIssuerCheck(inputs({ issuer: ok({ exists: true, ready: null }) })).status,
    'pass'
  );
  assert.equal(backupProxyCheck(withEnv({ BACKUP_PROXY_ENABLED: 'false' })).status, 'warn');
  assert.equal(
    metricsCheck(inputs({ metrics: ok({ ok: false, detail: 'ECONNREFUSED' }) })).status,
    'warn'
  );
  assert.equal(logsCheck(inputs({ logs: bad })).status, 'unknown');
  assert.equal(logsCheck(inputs()).status, 'pass');
});

test('summarize counts every status', () => {
  const checks = evaluateAll(
    inputs({ priorityClass: ok(false), issuer: bad, denyPolicies: ok([]) })
  );
  const summary = summarize(checks);
  assert.equal(summary.pass + summary.warn + summary.fail + summary.unknown, checks.length);
  assert.ok(summary.fail >= 1);
  assert.ok(summary.unknown >= 1);
});
