import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiserverEndpointsFrom,
  CNPG_METRICS_PORT,
  DATABASE_PLATFORM_POLICY,
  databasePlatformPolicy,
  objectStorageEgress,
  tenantDenyPolicy
} from '../src/kubernetes/security-policies';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const clear = { OBJECT_STORAGE_NAMESPACE: undefined, OBJECT_STORAGE_PORT: undefined };

test('in-cluster object storage is found from the endpoint host', () => {
  withEnv(clear, () => {
    assert.deepEqual(
      objectStorageEgress('http://object-storage.orchard-object-storage.svc.cluster.local:9000'),
      { namespace: 'orchard-object-storage', port: 9000 }
    );
    assert.deepEqual(objectStorageEgress('http://minio.storage.svc'), {
      namespace: 'storage',
      port: 80
    });
    assert.equal(objectStorageEgress('https://abc.r2.cloudflarestorage.com'), null);
    assert.equal(objectStorageEgress(null), null);
  });
  withEnv({ OBJECT_STORAGE_NAMESPACE: 'minio', OBJECT_STORAGE_PORT: '9001' }, () => {
    assert.deepEqual(objectStorageEgress('https://s3.example.com'), {
      namespace: 'minio',
      port: 9001
    });
  });
});

test('database pods admit the metrics namespace on the exporter port only', () => {
  withEnv({ PLATFORM_METRICS_NAMESPACE: 'observability' }, () => {
    const policy = databasePlatformPolicy('acme-web', { storage: null });
    assert.equal(policy.metadata?.name, DATABASE_PLATFORM_POLICY);
    assert.deepEqual(policy.spec?.podSelector, {
      matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }]
    });
    assert.deepEqual(policy.spec?.policyTypes, ['Ingress']);
    assert.deepEqual(policy.spec?.ingress, [
      {
        from: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'observability' } } }
        ],
        ports: [{ protocol: 'TCP', port: CNPG_METRICS_PORT }]
      }
    ]);
    assert.equal(policy.spec?.egress, undefined);
  });
});

test('database pods may reach in-cluster backup storage', () => {
  const policy = databasePlatformPolicy('acme-web', {
    metricsNamespace: 'orchard-metrics',
    storage: { namespace: 'orchard-object-storage', port: 9000 }
  });
  assert.deepEqual(policy.spec?.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.spec?.egress, [
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'orchard-object-storage' }
          }
        }
      ],
      ports: [{ protocol: 'TCP', port: 9000 }]
    }
  ]);
});

test('with Cilium the policy carries no operator or API server rules', () => {
  const plain = databasePlatformPolicy('acme-web', { storage: null });
  const nulled = databasePlatformPolicy('acme-web', {
    storage: null,
    apiserver: null,
    operatorNamespace: null
  });
  assert.deepEqual(nulled, plain);
  assert.deepEqual(plain.spec?.policyTypes, ['Ingress']);
  assert.equal(plain.spec?.egress, undefined);
});

test('without Cilium the policy admits the operator and reaches the API server', () => {
  const policy = databasePlatformPolicy('acme-web', {
    metricsNamespace: 'orchard-metrics',
    storage: null,
    apiserver: { ips: ['10.43.0.1', '192.168.1.5', 'fd00::1'], ports: [443, 6443] },
    operatorNamespace: 'cnpg-system'
  });
  assert.deepEqual(policy.spec?.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.spec?.egress, [
    {
      to: [
        { ipBlock: { cidr: '10.43.0.1/32' } },
        { ipBlock: { cidr: '192.168.1.5/32' } },
        { ipBlock: { cidr: 'fd00::1/128' } }
      ],
      ports: [
        { protocol: 'TCP', port: 443 },
        { protocol: 'TCP', port: 6443 }
      ]
    }
  ]);
  assert.deepEqual(policy.spec?.ingress?.[1], {
    from: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'cnpg-system' } },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'cloudnative-pg' } }
      }
    ],
    ports: [{ protocol: 'TCP', port: 8000 }]
  });
});

test('API server endpoints come from the service and its backends', () => {
  assert.deepEqual(
    apiserverEndpointsFrom(
      { spec: { clusterIP: '10.43.0.1', ports: [{ port: 443 }] } },
      { subsets: [{ addresses: [{ ip: '192.168.1.5' }], ports: [{ port: 6443 }] }] }
    ),
    { ips: ['10.43.0.1', '192.168.1.5'], ports: [443, 6443] }
  );
});

test('an API server with no listed backends is not an answer', () => {
  assert.equal(
    apiserverEndpointsFrom({ spec: { clusterIP: '10.43.0.1', ports: [{ port: 443 }] } }, {}),
    null
  );
});

test('the tenant policy follows the configured r2-proxy namespace', () => {
  const peer = (ns: string) => ({
    to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ns } } }],
    ports: [{ protocol: 'TCP', port: 9000 }]
  });
  withEnv({ PLATFORM_R2_PROXY_NAMESPACE: undefined }, () => {
    assert.deepEqual(tenantDenyPolicy('ns').spec?.egress?.at(-1), peer('orchard-r2-proxy'));
  });
  withEnv({ PLATFORM_R2_PROXY_NAMESPACE: 'backup-proxy' }, () => {
    assert.deepEqual(tenantDenyPolicy('ns').spec?.egress?.at(-1), peer('backup-proxy'));
  });
});
