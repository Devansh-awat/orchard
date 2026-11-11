import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GuardConsumer,
  GUARD_AUDIT_ACTION,
  GUARD_REASON
} from '../src/engine/consumers/guard.consumer';
import { GuardManifest, specDrift } from '../src/engine/guard/compare';
import { GuardCluster, GuardKey, LiveRead } from '../src/engine/guard/cluster';
import { PrismaGuardDesired } from '../src/engine/guard/desired';
import { RestoreLimiter } from '../src/engine/guard/restore-limiter';
import { buildEngineShards } from '../src/engine/shards';
import {
  DATABASE_PLATFORM_POLICY,
  basicAuthEnvoyConfig,
  databasePlatformPolicy,
  publicDeploymentPolicy,
  tenantDenyPolicy
} from '../src/kubernetes/security-policies';

const SCOPE = { projectId: 'p1', organizationId: 'o1' };

class FakeCluster implements GuardCluster {
  objects = new Map<string, GuardManifest>();

  writes: { op: 'create' | 'replace'; key: GuardKey; manifest: GuardManifest }[] = [];

  terminating = new Set<string>();

  secrets = new Map<string, string>();

  normalise: (m: GuardManifest) => GuardManifest = (m) => m;

  private id(key: GuardKey) {
    return `${key.kind}/${key.namespace}/${key.name}`;
  }

  put(key: GuardKey, manifest: GuardManifest) {
    this.objects.set(this.id(key), structuredClone(manifest));
  }

  async read(key: GuardKey): Promise<LiveRead> {
    const obj = this.objects.get(this.id(key));
    return obj ? { state: 'present', obj: structuredClone(obj) } : { state: 'absent' };
  }

  async namespaceActive(namespace: string) {
    return !this.terminating.has(namespace);
  }

  async create(key: GuardKey, manifest: GuardManifest) {
    this.writes.push({ op: 'create', key, manifest });
    const stored = this.normalise(structuredClone(manifest));
    this.put(key, stored);
    return structuredClone(stored);
  }

  async replace(key: GuardKey, manifest: GuardManifest) {
    this.writes.push({ op: 'replace', key, manifest });
    const stored = this.normalise(structuredClone(manifest));
    this.put(key, stored);
    return structuredClone(stored);
  }

  async secretValue(namespace: string, name: string) {
    return this.secrets.get(`${namespace}/${name}`) ?? null;
  }
}

function build(want: (key: GuardKey) => GuardManifest | null, expected: GuardKey[] = []) {
  const audits: any[] = [];
  const cluster = new FakeCluster();
  const consumer = new GuardConsumer(
    {} as any,
    {} as any,
    {
      log: async (entry: any) => {
        audits.push(entry);
      }
    } as any
  );
  let clock = 1_000_000;
  const c = consumer as any;
  c.cluster = cluster;
  c.desired = {
    desired: async (key: GuardKey) => {
      const manifest = want(key);
      return manifest ? { manifest, scope: SCOPE } : null;
    },
    expected: async () => expected
  };
  c.now = () => clock;
  c.limiter = new RestoreLimiter(undefined, () => clock);
  return {
    consumer,
    cluster,
    audits,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

const DENY: GuardKey = { kind: 'NetworkPolicy', namespace: 'acme', name: 'default-deny-all' };
const deny = () => tenantDenyPolicy('acme', { ingressNamespaces: ['network', 'orchard'] });
const wantDeny = (key: GuardKey) => (key.name === 'default-deny-all' ? deny() : null);

function opened(): GuardManifest {
  const obj = deny() as GuardManifest;
  obj.spec.ingress = [{}];
  obj.metadata!.resourceVersion = '42';
  return obj;
}

test('a deleted default-deny is restored at once and audited', async () => {
  const { consumer, cluster, audits } = build(wantDeny);
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  assert.equal(cluster.writes.length, 1);
  assert.equal(cluster.writes[0].op, 'create');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, GUARD_AUDIT_ACTION);
  assert.equal(audits[0].actorUserId, undefined);
  assert.equal(audits[0].organizationId, 'o1');
  assert.equal(audits[0].metadata.change, 'deleted');
  assert.equal(audits[0].metadata.reason, GUARD_REASON);
  assert.equal(audits[0].metadata.kind, 'NetworkPolicy');
  consumer.onModuleDestroy();
});

test('an edited policy is put back with optimistic concurrency', async () => {
  const { consumer, cluster, audits, advance } = build(wantDeny);
  cluster.put(DENY, opened());
  await assert.rejects(consumer.onEvent('NetworkPolicy', 'update', opened() as any));
  advance(11_000);
  await consumer.onEvent('NetworkPolicy', 'update', opened() as any);
  assert.equal(cluster.writes.length, 1);
  assert.equal(cluster.writes[0].op, 'replace');
  assert.equal(cluster.writes[0].manifest.metadata?.resourceVersion, '42');
  assert.deepEqual(audits[0].metadata.changed, ['spec.ingress']);
  assert.equal(audits[0].metadata.change, 'modified');
  consumer.onModuleDestroy();
});

test('a policy that matches, in any order, is left alone', async () => {
  const { consumer, cluster, audits } = build(wantDeny);
  const live = deny() as GuardManifest;
  live.spec.egress = [...live.spec.egress].reverse();
  live.spec.egress[0].ports = [{ port: 9000 }];
  await consumer.onEvent('NetworkPolicy', 'update', live as any);
  assert.equal(cluster.writes.length, 0);
  assert.equal(audits.length, 0);
});

test('nothing is restored once orchard no longer wants the object', async () => {
  const { consumer, cluster, audits, advance } = build(() => null);
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  advance(60_000);
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  assert.equal(cluster.writes.length, 0);
  assert.equal(audits.length, 0);
});

test('a namespace being torn down is not refilled', async () => {
  const { consumer, cluster, advance } = build(wantDeny);
  cluster.terminating.add('acme');
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  advance(60_000);
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  assert.equal(cluster.writes.length, 0);
});

test('an object fixed during the settle window is not rewritten', async () => {
  const { consumer, cluster, audits, advance } = build(wantDeny);
  cluster.put(DENY, opened());
  await assert.rejects(consumer.onEvent('NetworkPolicy', 'update', opened() as any));
  cluster.put(DENY, deny());
  advance(11_000);
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  assert.equal(cluster.writes.length, 0);
  assert.equal(audits.length, 0);
  consumer.onModuleDestroy();
});

test('a missing label is put back quietly', async () => {
  const { consumer, cluster, audits, advance } = build(wantDeny);
  const live = deny() as GuardManifest;
  live.metadata!.labels = { 'orchard.my/managed': 'true' };
  cluster.put(DENY, live);
  await assert.rejects(consumer.onEvent('NetworkPolicy', 'update', live as any));
  advance(11_000);
  await consumer.onEvent('NetworkPolicy', 'update', live as any);
  assert.equal(cluster.writes.length, 1);
  assert.equal(audits.length, 0);
  consumer.onModuleDestroy();
});

test('a fight with another writer backs off instead of hot-looping', async () => {
  const { consumer, cluster, audits, advance } = build(wantDeny);
  let restores = 0;
  for (let i = 0; i < 12; i++) {
    cluster.put(DENY, opened());
    advance(11_000);
    const before = cluster.writes.length;
    await consumer.onEvent('NetworkPolicy', 'update', opened() as any).catch(() => {});
    if (cluster.writes.length > before) restores += 1;
  }
  assert.ok(restores >= 3, `restored ${restores} times`);
  assert.ok(restores <= 5, `restored ${restores} times in 132s`);
  assert.equal(audits.length, restores);
  consumer.onModuleDestroy();
});

test('an apiserver that stores the spec in its own shape is accepted after one restore', async () => {
  const { consumer, cluster, audits, advance } = build(wantDeny);
  cluster.normalise = (m) => {
    m.spec.extraDefault = true;
    return m;
  };
  await consumer.onEvent('NetworkPolicy', 'delete', deny() as any);
  assert.equal(cluster.writes.length, 1);
  const stored = (await cluster.read(DENY)) as any;
  advance(60_000);
  await consumer.onEvent('NetworkPolicy', 'update', stored.obj);
  assert.equal(cluster.writes.length, 1);
  assert.equal(audits.length, 1);
  consumer.onModuleDestroy();
});

test('the sweep restores an expected policy the watch never saw', async () => {
  const { consumer, cluster, advance } = build(wantDeny, [DENY]);
  await consumer.sweep('NetworkPolicy', []);
  advance(11_000);
  await consumer.sweep('NetworkPolicy', []);
  assert.equal(cluster.writes.length, 1);
  await consumer.sweep('NetworkPolicy', [
    { namespace: 'acme', name: 'default-deny-all', refs: {} }
  ]);
  assert.equal(cluster.writes.length, 1);
  consumer.onModuleDestroy();
});

test('a policy left in the shape an older server wrote is updated on the first check', async () => {
  const key: GuardKey = {
    kind: 'NetworkPolicy',
    namespace: 'acme',
    name: DATABASE_PLATFORM_POLICY
  };
  const apiserver = { ips: ['10.43.0.1', '203.0.113.10'], ports: [443, 6443] };
  const current = () =>
    databasePlatformPolicy('acme', {
      storage: null,
      apiserver,
      operatorNamespace: 'cnpg-system'
    }) as GuardManifest;
  const { consumer, cluster } = build(
    (k) => (k.name === DATABASE_PLATFORM_POLICY ? current() : null),
    [key]
  );
  (consumer as any).clusterAddresses = async () => ['203.0.113.10/32'];
  const older = databasePlatformPolicy('acme', { storage: null }) as GuardManifest;
  older.metadata!.resourceVersion = '7';
  cluster.put(key, older);

  await consumer.checkTenantPolicies();

  assert.equal(cluster.writes.length, 1);
  assert.equal(cluster.writes[0].op, 'replace');
  const live = (await cluster.read(key)) as { state: 'present'; obj: GuardManifest };
  assert.deepEqual(live.obj.spec.policyTypes, ['Ingress', 'Egress']);
  const toApiserver = live.obj.spec.egress.find((rule: any) =>
    rule.to?.some((peer: any) => peer.ipBlock?.cidr === '203.0.113.10/32')
  );
  assert.ok(toApiserver, 'the database pods can reach the API server again');
  assert.ok(toApiserver.ports.some((p: any) => p.port === 6443));

  await consumer.checkTenantPolicies();
  assert.equal(cluster.writes.length, 1);
  consumer.onModuleDestroy();
});

test('the restore limiter allows a burst, then doubles the wait up to the cap', () => {
  let now = 0;
  const limiter = new RestoreLimiter(
    { minIntervalMs: 30_000, burst: 3, windowMs: 3_600_000, maxBackoffMs: 120_000 },
    () => now
  );
  assert.equal(limiter.check('k').allowed, true);
  limiter.record('k');
  assert.equal(limiter.check('k').allowed, false);
  now += 30_000;
  limiter.record('k');
  now += 30_000;
  const third = limiter.record('k');
  assert.equal(third.backingOff, true);
  assert.equal(third.nextAllowedAt - now, 60_000);
  now += 60_000;
  assert.equal(limiter.check('k').allowed, true);
  limiter.record('k');
  now += 119_000;
  assert.equal(limiter.check('k').allowed, false);
  now += 1_000;
  assert.equal(limiter.check('k').allowed, true);
  limiter.record('k');
  now += 120_000;
  assert.equal(limiter.check('k').allowed, true);
  now += 4_000_000;
  const fresh = limiter.record('k');
  assert.equal(fresh.backingOff, false);
});

function fakePrisma(opts: {
  ingresses?: any[];
  ports?: { deploymentId: string; targetPort: number; protocol: string }[];
  deployments?: { id: string; name: string; namespace: string }[];
  protectedCount?: number;
}) {
  return {
    project: {
      findFirst: async ({ where }: any) =>
        where.namespace === 'acme' ? { id: 'p1', organizationId: 'o1' } : null,
      findUnique: async () => ({ namespace: 'acme', environments: [{ namespace: 'acme' }] }),
      findMany: async () => [{ namespace: 'acme', environments: [{ namespace: 'acme' }] }]
    },
    environment: { findUnique: async () => null },
    ingress: {
      count: async () => opts.protectedCount ?? 0,
      findMany: async ({ where }: any) =>
        (opts.ingresses ?? []).filter(
          (r) => r.namespace === where.namespace && r.name === where.name
        )
    },
    deployment: {
      findMany: async ({ where }: any) =>
        (opts.deployments ?? []).filter((d) => d.namespace === where.namespace)
    },
    database: { findMany: async () => [], count: async () => 0 },
    servicePort: {
      findMany: async ({ where }: any) =>
        (opts.ports ?? []).filter((p) => p.deploymentId === where.service?.deploymentId)
    }
  } as any;
}

test('desired: default-deny opens to the protection proxy only while the namespace has protected hosts', async () => {
  const previous = process.env.TENANT_INGRESS_NAMESPACES;
  process.env.TENANT_INGRESS_NAMESPACES = 'network';
  try {
    const cluster = new FakeCluster();
    const plain = new PrismaGuardDesired(fakePrisma({}), async () => true, cluster);
    const guarded = new PrismaGuardDesired(
      fakePrisma({ protectedCount: 1 }),
      async () => true,
      cluster
    );
    const a = await plain.desired(DENY, null);
    const b = await guarded.desired(DENY, null);
    const peers = (m: any) =>
      m.spec.ingress[0].from.map(
        (p: any) => p.namespaceSelector.matchLabels['kubernetes.io/metadata.name']
      );
    assert.deepEqual(peers(a!.manifest), ['acme', 'network']);
    assert.deepEqual(peers(b!.manifest), ['acme', 'network', 'orchard']);
    assert.equal(a!.manifest.metadata?.labels?.['app.kubernetes.io/managed-by'], 'orchard');
  } finally {
    if (previous === undefined) delete process.env.TENANT_INGRESS_NAMESPACES;
    else process.env.TENANT_INGRESS_NAMESPACES = previous;
  }
});

test('desired: the database platform policy only opens up without Cilium, and a failed read rewrites nothing', async () => {
  const key: GuardKey = {
    kind: 'NetworkPolicy',
    namespace: 'acme',
    name: 'allow-database-platform'
  };
  const prisma = fakePrisma({});
  prisma.database.count = async () => 1;
  const endpoints = async () => ({ ips: ['10.43.0.1'], ports: [443] });
  const cluster = new FakeCluster();

  const cilium = await new PrismaGuardDesired(prisma, async () => true, cluster, endpoints).desired(
    key,
    null
  );
  assert.equal(cilium!.manifest.spec.ingress.length, 1);

  const flannel = await new PrismaGuardDesired(
    prisma,
    async () => false,
    cluster,
    endpoints
  ).desired(key, null);
  assert.equal(flannel!.manifest.spec.ingress.length, 2);
  assert.ok(flannel!.manifest.spec.policyTypes.includes('Egress'));

  await assert.rejects(
    new PrismaGuardDesired(
      prisma,
      async () => false,
      cluster,
      async () => {
        throw new Error('apiserver unreachable');
      }
    ).desired(key, null),
    /apiserver unreachable/
  );
});

test('desired: nothing for a namespace orchard does not own', async () => {
  const desired = new PrismaGuardDesired(fakePrisma({}), async () => true, new FakeCluster());
  assert.equal(await desired.desired({ ...DENY, namespace: 'kube-system' }, null), null);
});

test('desired: a public policy exists only while a port is public', async () => {
  const key: GuardKey = { kind: 'NetworkPolicy', namespace: 'acme', name: 'web-allow-public' };
  const deployments = [{ id: 'd1', name: 'web', namespace: 'acme' }];
  const closed = new PrismaGuardDesired(
    fakePrisma({ deployments }),
    async () => true,
    new FakeCluster()
  );
  assert.equal(await closed.desired(key, null), null);
  const open = new PrismaGuardDesired(
    fakePrisma({
      deployments,
      ports: [{ deploymentId: 'd1', targetPort: 25565, protocol: 'tcp' }]
    }),
    async () => true,
    new FakeCluster()
  );
  const got = await open.desired(key, null);
  assert.deepEqual(
    specDrift(
      'NetworkPolicy',
      got!.manifest.spec,
      publicDeploymentPolicy('acme', 'web', [{ port: 25565, protocol: 'TCP' }]).spec
    ),
    []
  );
});

test('desired: a basic-auth envoy config only while its secret and ingress row exist', async () => {
  const key: GuardKey = { kind: 'CiliumEnvoyConfig', namespace: 'acme', name: 'site-auth' };
  const ingresses = [
    { namespace: 'acme', name: 'site', servicePort: 80, service: { name: 'web', port: 80 } },
    { namespace: 'acme', name: 'site', servicePort: 8080, service: { name: 'api', port: 8080 } }
  ];
  const cluster = new FakeCluster();
  const desired = new PrismaGuardDesired(fakePrisma({ ingresses }), async () => true, cluster);
  assert.equal(await desired.desired(key, null), null);

  cluster.secrets.set('acme/site-basic-auth', 'bob:{SHA}abc=');
  const first = await desired.desired(key, null);
  assert.deepEqual(
    first!.manifest,
    basicAuthEnvoyConfig('acme', 'site', 'bob:{SHA}abc=', 'web', 80)
  );

  const hinted = await desired.desired(key, {
    spec: { services: [{ name: 'api', ports: [8080] }] }
  });
  assert.equal(hinted!.manifest.spec.services[0].name, 'api');

  const elsewhere = await desired.desired(key, {
    spec: { services: [{ name: 'evil', ports: [1] }] }
  });
  assert.equal(elsewhere!.manifest.spec.services[0].name, 'web');

  const noCilium = new PrismaGuardDesired(fakePrisma({ ingresses }), async () => false, cluster);
  assert.equal(await noCilium.desired(key, null), null);
});

test('the guard shard watches cilium kinds only when they can be watched', () => {
  const deps = (cilium: { networkPolicies: boolean; envoyConfigs: boolean }) =>
    ({
      certManager: false,
      cilium,
      guard: {},
      namespaceRefs: async () => ({})
    }) as any;
  const off = buildEngineShards(deps({ networkPolicies: false, envoyConfigs: false })).find(
    (s) => s.name === 'guard'
  )!;
  assert.equal(off.lease, 'orchard-mirror-guard');
  assert.deepEqual(
    off.resources.map((r) => r.kind),
    ['NetworkPolicy']
  );
  assert.equal(off.resources[0].labelSelector, 'app.kubernetes.io/managed-by=orchard');
  const on = buildEngineShards(deps({ networkPolicies: true, envoyConfigs: true })).find(
    (s) => s.name === 'guard'
  )!;
  assert.deepEqual(
    on.resources.map((r) => r.kind),
    ['NetworkPolicy', 'CiliumNetworkPolicy', 'CiliumEnvoyConfig']
  );
  assert.equal(on.resources[2].labelSelector, 'orchard.my/type=basic-auth');
});
