import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CILIUM_DENY_POLICY,
  DATABASE_PLATFORM_POLICY,
  TENANT_DENY_POLICY,
  ciliumDenyPolicy,
  egressPortsAvoiding,
  tenantDenyPolicy
} from '../src/kubernetes/security-policies';
import { ipv4Excepts, nodeAddresses } from '../src/kubernetes/cluster-addresses';
import { GuardConsumer } from '../src/engine/consumers/guard.consumer';
import { PrismaGuardDesired } from '../src/engine/guard/desired';
import type { GuardKey } from '../src/engine/guard/cluster';

const ingressNamespaces = ['network', 'orchard'];

const peerNamespace = (peer: any) =>
  peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];

function toNetwork(policy: any) {
  return policy.spec.egress.find((rule: any) =>
    rule.to?.some((p: any) => peerNamespace(p) === 'network')
  );
}

function toInternet(policy: any) {
  return policy.spec.egress.find((rule: any) => rule.to?.[0]?.ipBlock);
}

test('egress to the ingress controller namespace is limited to serving ports', () => {
  const rule = toNetwork(tenantDenyPolicy('acme', { ingressNamespaces }));
  assert.deepEqual(
    rule.ports.map((p: any) => p.port),
    [80, 443, 8000, 8080, 8443]
  );
  assert.ok(rule.ports.every((p: any) => p.protocol === 'TCP'));
  for (const port of [1024, 6060, 10254, 9100]) {
    assert.ok(!rule.ports.some((p: any) => p.port === port));
  }
});

test('the tenant own namespace stays open on every port and is not mixed with the controller rule', () => {
  const policy: any = tenantDenyPolicy('acme', { ingressNamespaces });
  const own = policy.spec.egress[0];
  assert.equal(own.ports, undefined);
  assert.deepEqual(own.to.map(peerNamespace), ['acme']);
});

test('TENANT_INGRESS_PORTS overrides the serving ports', () => {
  const saved = process.env.TENANT_INGRESS_PORTS;
  process.env.TENANT_INGRESS_PORTS = '80,9999,bogus';
  try {
    const rule = toNetwork(tenantDenyPolicy('acme', { ingressNamespaces }));
    assert.deepEqual(
      rule.ports.map((p: any) => p.port),
      [80, 9999]
    );
  } finally {
    if (saved === undefined) delete process.env.TENANT_INGRESS_PORTS;
    else process.env.TENANT_INGRESS_PORTS = saved;
  }
});

function withBlockPorts(value: string | undefined, run: () => void) {
  const saved = process.env.TENANT_EGRESS_BLOCK_PORTS;
  if (value === undefined) delete process.env.TENANT_EGRESS_BLOCK_PORTS;
  else process.env.TENANT_EGRESS_BLOCK_PORTS = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.TENANT_EGRESS_BLOCK_PORTS;
    else process.env.TENANT_EGRESS_BLOCK_PORTS = saved;
  }
}

const tcpCovered = (rule: any, port: number) =>
  rule.ports === undefined ||
  rule.ports.some(
    (p: any) => p.protocol === 'TCP' && port >= p.port && port <= (p.endPort ?? p.port)
  );

test('tenants reach the internet on mail ports by default', () => {
  withBlockPorts(undefined, () => {
    const internet = toInternet(tenantDenyPolicy('acme', { ingressNamespaces }));
    assert.equal(internet.ports, undefined);
    for (const port of [25, 465, 587, 2525]) assert.equal(tcpCovered(internet, port), true);
    const deny = ciliumDenyPolicy('acme');
    assert.ok(deny.spec.egressDeny.every((rule: any) => rule.toPorts === undefined));
  });
});

test('egressPortsAvoiding leaves out exactly the blocked TCP ports', () => {
  assert.deepEqual(egressPortsAvoiding([25, 465, 587, 2525]), [
    { protocol: 'TCP', port: 1, endPort: 24 },
    { protocol: 'TCP', port: 26, endPort: 464 },
    { protocol: 'TCP', port: 466, endPort: 586 },
    { protocol: 'TCP', port: 588, endPort: 2524 },
    { protocol: 'TCP', port: 2526, endPort: 65535 },
    { protocol: 'UDP' }
  ]);
  assert.deepEqual(egressPortsAvoiding([1, 65535, 3]), [
    { protocol: 'TCP', port: 2 },
    { protocol: 'TCP', port: 4, endPort: 65534 },
    { protocol: 'UDP' }
  ]);
});

test('TENANT_EGRESS_BLOCK_PORTS still blocks the ports an operator lists', () => {
  withBlockPorts('25,bogus,587', () => {
    const internet = toInternet(tenantDenyPolicy('acme', { ingressNamespaces }));
    for (const port of [25, 587]) assert.equal(tcpCovered(internet, port), false);
    for (const port of [22, 80, 443, 465, 2525, 65535]) {
      assert.equal(tcpCovered(internet, port), true);
    }
    const deny = ciliumDenyPolicy('acme');
    assert.deepEqual(
      deny.spec.egressDeny[1].toPorts[0].ports.map((p: any) => p.port),
      ['25', '587']
    );
  });
  withBlockPorts('none', () => {
    assert.equal(toInternet(tenantDenyPolicy('acme', { ingressNamespaces })).ports, undefined);
  });
});

test('cluster addresses join the except list of the internet rule', () => {
  const policy = tenantDenyPolicy('acme', {
    ingressNamespaces,
    clusterExcepts: ['203.0.113.7/32', '198.51.100.0/24']
  });
  const block = toInternet(policy).to[0].ipBlock;
  assert.equal(block.cidr, '0.0.0.0/0');
  assert.ok(block.except.includes('10.0.0.0/8'));
  assert.ok(block.except.includes('203.0.113.7/32'));
  assert.ok(block.except.includes('198.51.100.0/24'));
});

test('node, apiserver and pod addresses become sorted, deduplicated ipv4 excepts', () => {
  const nodes: any[] = [
    {
      status: {
        addresses: [
          { type: 'InternalIP', address: '10.0.0.5' },
          { type: 'ExternalIP', address: '203.0.113.7' },
          { type: 'ExternalIP', address: '2001:db8::7' },
          { type: 'Hostname', address: 'node-a' }
        ]
      },
      spec: { podCIDRs: ['100.64.1.0/24', '198.18.0.0/24'] }
    },
    { status: { addresses: [{ type: 'ExternalIP', address: '203.0.113.7' }] } }
  ];
  const found = ipv4Excepts([
    ...nodeAddresses(nodes),
    '203.0.113.7',
    '203.0.113.9',
    'garbage',
    '0.0.0.0/0'
  ]);
  assert.deepEqual(found, ['198.18.0.0/24', '203.0.113.7/32', '203.0.113.9/32']);
  assert.deepEqual(ipv4Excepts(['203.0.113.0/24', '203.0.113.7']), ['203.0.113.0/24']);
  assert.deepEqual(ipv4Excepts(['10.1.2.3', '192.168.1.1', '169.254.169.254']), []);
});

test('ipv6 stays default-deny: the only ip block is v4', () => {
  const policy: any = tenantDenyPolicy('acme', {
    ingressNamespaces,
    clusterExcepts: ['203.0.113.7/32']
  });
  const blocks = policy.spec.egress
    .flatMap((rule: any) => rule.to ?? [])
    .filter((p: any) => p.ipBlock);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].ipBlock.cidr, '0.0.0.0/0');
  assert.ok(blocks[0].ipBlock.except.every((cidr: string) => !cidr.includes(':')));
});

test('the cilium deny keeps tenants off host, remote nodes and the apiserver but exempts databases', () => {
  const policy = ciliumDenyPolicy('acme');
  assert.equal(policy.metadata.name, CILIUM_DENY_POLICY);
  assert.equal(policy.metadata.labels['orchard.my/managed'], 'true');
  assert.deepEqual(policy.spec.egressDeny[0].toEntities, ['host', 'remote-node', 'kube-apiserver']);
  assert.deepEqual(policy.spec.endpointSelector.matchExpressions, [
    { key: 'cnpg.io/cluster', operator: 'DoesNotExist' }
  ]);
});

test('the guard builds the tenant policy with the live cluster addresses and expects the cilium deny', async () => {
  const prisma: any = {
    project: { findMany: async () => [{ namespace: 'acme', environments: [] }] },
    servicePort: { findMany: async () => [] },
    database: { findMany: async () => [], count: async () => 0 },
    ingress: { count: async () => 0 }
  };
  const desired = new PrismaGuardDesired(
    prisma,
    async () => true,
    {} as any,
    async () => null,
    async () => ['203.0.113.7/32']
  );
  const keys = await desired.expected('CiliumNetworkPolicy');
  assert.ok(keys.some((key) => key.name === CILIUM_DENY_POLICY && key.namespace === 'acme'));
  const policy = await (desired as any).networkPolicy(
    { kind: 'NetworkPolicy', namespace: 'acme', name: TENANT_DENY_POLICY },
    'p1'
  );
  assert.ok(toInternet(policy).to[0].ipBlock.except.includes('203.0.113.7/32'));
  const deny = await (desired as any).ciliumPolicy({
    kind: 'CiliumNetworkPolicy',
    namespace: 'acme',
    name: CILIUM_DENY_POLICY
  });
  assert.ok(deny.spec.egressDeny.length > 0);
});

function guardWith(
  addresses: () => Promise<string[]>,
  live: Set<string> | null,
  expected: GuardKey[]
) {
  const consumer: any = new GuardConsumer({} as any, {} as any, { log: async () => {} } as any);
  const enforced: { key: GuardKey; rollForward: boolean }[] = [];
  consumer.clusterAddresses = addresses;
  consumer.desired = { expected: async () => expected, desired: async () => null };
  consumer.cluster = { namespacesWithPolicy: async () => live };
  consumer.enforce = async (key: GuardKey, _hint: unknown, rollForward = false) => {
    enforced.push({ key, rollForward });
    return 'ok';
  };
  return { consumer: consumer as GuardConsumer, enforced };
}

const denyKey = (namespace: string): GuardKey => ({
  kind: 'NetworkPolicy',
  namespace,
  name: TENANT_DENY_POLICY
});

const platformKey = (namespace: string): GuardKey => ({
  kind: 'NetworkPolicy',
  namespace,
  name: DATABASE_PLATFORM_POLICY
});

test('the first check after boot verifies every guarded policy, present or not', async () => {
  const { consumer, enforced } = guardWith(async () => ['203.0.113.7/32'], new Set(['a']), [
    denyKey('a'),
    platformKey('a'),
    denyKey('b')
  ]);
  await consumer.checkTenantPolicies();
  assert.deepEqual(
    enforced.map((e) => [e.key.namespace, e.key.name, e.rollForward]),
    [
      ['a', TENANT_DENY_POLICY, true],
      ['a', DATABASE_PLATFORM_POLICY, true],
      ['b', TENANT_DENY_POLICY, true]
    ]
  );
});

test('later checks recreate a missing default-deny and leave present ones alone', async () => {
  const { consumer, enforced } = guardWith(async () => ['203.0.113.7/32'], new Set(['a']), [
    denyKey('a'),
    platformKey('a'),
    denyKey('b')
  ]);
  await consumer.checkTenantPolicies();
  enforced.length = 0;
  await consumer.checkTenantPolicies();
  assert.deepEqual(
    enforced.map((e) => [e.key.namespace, e.rollForward]),
    [['b', false]]
  );
});

test('a change in node addresses rolls every address-bound policy forward', async () => {
  let addresses = ['203.0.113.7/32'];
  const { consumer, enforced } = guardWith(async () => addresses, new Set(['a', 'b']), [
    denyKey('a'),
    platformKey('a'),
    denyKey('b')
  ]);
  await consumer.checkTenantPolicies();
  enforced.length = 0;
  await consumer.checkTenantPolicies();
  assert.equal(enforced.length, 0);
  addresses = ['203.0.113.7/32', '203.0.113.8/32'];
  await consumer.checkTenantPolicies();
  assert.deepEqual(
    enforced.map((e) => [e.key.namespace, e.key.name, e.rollForward]),
    [
      ['a', TENANT_DENY_POLICY, true],
      ['a', DATABASE_PLATFORM_POLICY, true],
      ['b', TENANT_DENY_POLICY, true]
    ]
  );
});
