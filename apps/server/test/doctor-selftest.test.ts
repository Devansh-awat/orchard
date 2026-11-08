import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import {
  buildTargets,
  checksFromResults,
  parseProbeLog,
  probeInput,
  probeScript,
  resolveTargets,
  safeTarget,
  verdictFor,
  type ProbeTarget,
  type Topology
} from '../src/doctor/selftest.plan';
import { SelfTestService } from '../src/doctor/selftest.service';
import {
  LISTENER_PORT,
  type NamespaceShape,
  type PodState,
  type SelfTestCluster,
  type SelfTestPodInput
} from '../src/doctor/selftest.types';
import { externalTarget, selfTestPod } from '../src/doctor/selftest.cluster';

function topology(overrides: Partial<Topology> = {}): Topology {
  return {
    apiserver: { ips: ['10.96.0.1', '192.0.2.10'], ports: [443, 6443] },
    nodes: [{ name: 'n1', addresses: ['192.0.2.20', '198.51.100.20'] }],
    platformServices: [
      { namespace: 'orchard', name: 'server', ip: '10.96.1.1', ports: [3001] },
      { namespace: 'orchard', name: 'postgres-rw', ip: '10.96.1.2', ports: [5432] },
      { namespace: 'orchard', name: 'redis', ip: '10.96.1.3', ports: [6379] }
    ],
    ingressPods: [
      { namespace: 'network', name: 'haproxy-1', ip: '10.244.0.9', ports: [80, 443, 1024] }
    ],
    ingressServingPorts: [80, 443, 8000, 8080, 8443],
    ingressExtraPorts: [9999],
    metadataAddress: '169.254.169.254',
    external: { host: '1.1.1.1', port: 443 },
    sameNamespaceListener: { ip: '10.244.1.5', port: LISTENER_PORT },
    otherTenantListener: { ip: '10.244.2.5', port: LISTENER_PORT },
    ...overrides
  };
}

test('targets cover apiserver, every node address on the management ports, metadata, platform, ingress debug ports and a foreign tenant', () => {
  const targets = buildTargets(topology());
  const has = (host: string, port: number) =>
    targets.some((t) => t.host === host && t.port === port && t.expect === 'blocked');
  assert.ok(has('10.96.0.1', 443));
  assert.ok(has('192.0.2.10', 6443));
  for (const address of ['192.0.2.20', '198.51.100.20']) {
    for (const port of [10250, 22, 6443, 50000])
      assert.ok(has(address, port), `${address}:${port}`);
  }
  assert.ok(has('169.254.169.254', 80));
  assert.ok(has('10.96.1.2', 5432));
  assert.ok(has('10.96.1.3', 6379));
  for (const port of [1024, 1042, 6060, 9999]) assert.ok(has('10.244.0.9', port), String(port));
  assert.ok(!has('10.244.0.9', 80));
  assert.ok(!has('10.244.0.9', 443));
  assert.ok(has('10.244.2.5', LISTENER_PORT));
  const ids = targets.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('positive controls cover DNS, the internet, a same-namespace listener and an ingress serving port', () => {
  const controls = buildTargets(topology()).filter((t) => t.group === 'control');
  assert.deepEqual(
    controls.map((c) => c.kind + ':' + c.port),
    ['dns:0', 'tcp:443', `tcp:${LISTENER_PORT}`, 'tcp:80']
  );
  assert.ok(controls.every((c) => c.expect === 'open'));
});

test('targets with unsafe hosts are dropped so nothing reaches the probe shell', () => {
  assert.equal(safeTarget('10.0.0.1', 80, 'tcp'), true);
  assert.equal(safeTarget('1.2.3.4; rm -rf /', 80, 'tcp'), false);
  assert.equal(safeTarget('$(id)', 80, 'tcp'), false);
  assert.equal(safeTarget('10.0.0.1', 70000, 'tcp'), false);
  const targets = buildTargets(
    topology({ platformServices: [{ namespace: 'x', name: 'y', ip: '1.1.1.1;id', ports: [1] }] })
  );
  assert.ok(!targets.some((t) => t.host.includes(';')));
  assert.ok(
    probeInput(targets)
      .split('\n')
      .every((line) => /^t\d+ (tcp|dns) [A-Za-z0-9.:_-]+ \d+$/.test(line))
  );
});

test('the probe script does not interpolate targets and reads them from the environment', () => {
  const script = probeScript();
  assert.match(script, /\$PROBE_TARGETS/);
  assert.match(script, /\/dev\/tcp/);
  assert.match(script, /timeout /);
});

test('probe log parsing keeps the first answer per target and notices completion', () => {
  const parsed = parseProbeLog(
    'noise\nRESULT t0 open\nRESULT t1 timeout\nRESULT t1 open\nRESULT t2 bogus\nDONE\n'
  );
  assert.equal(parsed.done, true);
  assert.equal(parsed.outcomes.get('t0'), 'open');
  assert.equal(parsed.outcomes.get('t1'), 'timeout');
  assert.equal(parsed.outcomes.has('t2'), false);
  assert.equal(parseProbeLog('RESULT t0 open').done, false);
});

const target = (
  expect: 'open' | 'blocked',
  group: ProbeTarget['group'] = 'nodes'
): ProbeTarget => ({
  id: 't1',
  group,
  kind: 'tcp',
  label: 'x',
  host: '10.0.0.1',
  port: 22,
  expect
});

test('verdicts: a refused connection means the packet arrived, so it is not blocked', () => {
  assert.equal(verdictFor(target('blocked'), 'timeout'), 'blocked');
  assert.equal(verdictFor(target('blocked'), 'unreachable'), 'blocked');
  assert.equal(verdictFor(target('blocked'), 'open'), 'reached');
  assert.equal(verdictFor(target('blocked'), 'refused'), 'reached');
  assert.equal(verdictFor(target('blocked'), 'dns'), 'inconclusive');
  assert.equal(verdictFor(target('blocked'), 'error'), 'inconclusive');
  assert.equal(verdictFor(target('open', 'control'), 'open'), 'control-ok');
  assert.equal(verdictFor(target('open', 'control'), 'timeout'), 'control-failed');
});

function allBlockedLog(targets: ProbeTarget[], overrides: Record<string, string> = {}): string {
  return (
    targets
      .map((t) => `RESULT ${t.id} ${overrides[t.id] ?? (t.expect === 'open' ? 'open' : 'timeout')}`)
      .join('\n') + '\nDONE\n'
  );
}

test('all dropped with working controls passes every group', () => {
  const targets = buildTargets(topology());
  const results = resolveTargets(targets, parseProbeLog(allBlockedLog(targets)));
  const checks = checksFromResults(results);
  assert.ok(
    checks.every((c) => c.status === 'pass'),
    JSON.stringify(checks.map((c) => [c.id, c.status]))
  );
  assert.ok(checks.some((c) => c.id === 'selftest-cross-tenant'));
});

test('a reachable target fails its group and names the address', () => {
  const targets = buildTargets(topology());
  const node = targets.find((t) => t.host === '192.0.2.20' && t.port === 10250)!;
  const results = resolveTargets(
    targets,
    parseProbeLog(allBlockedLog(targets, { [node.id]: 'open' }))
  );
  const checks = checksFromResults(results);
  const nodes = checks.find((c) => c.id === 'selftest-nodes')!;
  assert.equal(nodes.status, 'fail');
  assert.match(nodes.evidence, /192\.0\.2\.20:10250/);
  assert.equal(checks.find((c) => c.id === 'selftest-apiserver')!.status, 'pass');
});

test('a failed positive control turns every would-be pass into unknown, never pass', () => {
  const targets = buildTargets(topology());
  const dns = targets.find((t) => t.kind === 'dns')!;
  const results = resolveTargets(
    targets,
    parseProbeLog(allBlockedLog(targets, { [dns.id]: 'dns' }))
  );
  const checks = checksFromResults(results);
  assert.equal(checks.find((c) => c.id === 'selftest-controls')!.status, 'unknown');
  for (const c of checks.filter((x) => x.id !== 'selftest-controls')) {
    assert.equal(c.status, 'unknown', c.id);
  }
});

test('a failed control does not hide a connection that was actually made', () => {
  const targets = buildTargets(topology());
  const dns = targets.find((t) => t.kind === 'dns')!;
  const meta = targets.find((t) => t.group === 'metadata')!;
  const results = resolveTargets(
    targets,
    parseProbeLog(allBlockedLog(targets, { [dns.id]: 'dns', [meta.id]: 'open' }))
  );
  assert.equal(
    checksFromResults(results).find((c) => c.id === 'selftest-metadata')!.status,
    'fail'
  );
});

test('a probe that produced no log leaves controls failed and every verdict unknown', () => {
  const targets = buildTargets(topology());
  const checks = checksFromResults(resolveTargets(targets, null));
  assert.ok(checks.every((c) => c.status === 'unknown'));
});

test('a group with no discovered targets is unknown, and an inconclusive probe is unknown', () => {
  const targets = buildTargets(topology({ ingressPods: [], apiserver: null }));
  const checks = checksFromResults(resolveTargets(targets, parseProbeLog(allBlockedLog(targets))));
  assert.equal(checks.find((c) => c.id === 'selftest-ingress-ports')!.status, 'unknown');
  assert.equal(checks.find((c) => c.id === 'selftest-apiserver')!.status, 'unknown');
  const full = buildTargets(topology());
  const platform = full.find((t) => t.group === 'platform')!;
  const inconclusive = checksFromResults(
    resolveTargets(full, parseProbeLog(allBlockedLog(full, { [platform.id]: 'error' })))
  );
  assert.equal(inconclusive.find((c) => c.id === 'selftest-platform')!.status, 'unknown');
});

test('probe and listener pods are hardened, tenant-shaped and labelled for the reaper', () => {
  const env = { TENANT_RUNTIME_CLASS: 'gvisor' } as NodeJS.ProcessEnv;
  const probe = selfTestPod(
    { name: 'probe', role: 'probe', env: { PROBE_TARGETS: 't0 dns a 0' } },
    env
  );
  assert.equal(probe.spec?.runtimeClassName, 'gvisor');
  assert.equal(probe.spec?.automountServiceAccountToken, false);
  assert.equal(probe.spec?.restartPolicy, 'Never');
  const sc = probe.spec!.containers[0].securityContext as any;
  assert.equal(sc.allowPrivilegeEscalation, false);
  assert.deepEqual(sc.capabilities.drop, ['ALL']);
  assert.equal(sc.seccompProfile.type, 'RuntimeDefault');
  assert.equal(probe.metadata?.labels?.['orchard.my/selftest'], 'true');
  assert.equal(probe.spec!.containers[0].env![0].value, 't0 dns a 0');
  assert.equal(
    selfTestPod({ name: 'l', role: 'listener' }, {} as any).spec?.runtimeClassName,
    undefined
  );
  assert.deepEqual(externalTarget('example.com:8443'), { host: 'example.com', port: 8443 });
  assert.deepEqual(externalTarget('bad value'), { host: '1.1.1.1', port: 443 });
});

interface FakeOptions {
  failCreateNamespace?: string;
  failDiscover?: boolean;
  probeLog?: (targets: string) => string;
  listenerIp?: string | null;
  probePhase?: string;
  stuckDelete?: string[];
  existing?: { name: string; createdAt: number }[];
  shape?: Partial<NamespaceShape>;
  logThrows?: boolean;
}

function fakeCluster(options: FakeOptions = {}) {
  const namespaces = new Map<string, { labels: Record<string, string>; createdAt: number }>();
  for (const e of options.existing ?? [])
    namespaces.set(e.name, { labels: {}, createdAt: e.createdAt });
  const pods: Record<string, SelfTestPodInput> = {};
  const deleted: string[] = [];
  const cluster: SelfTestCluster = {
    async createTenantNamespace(name, labels) {
      namespaces.set(name, { labels, createdAt: Date.now() });
      if (options.failCreateNamespace === name) throw new Error('apiserver unavailable');
    },
    async namespaceShape() {
      return {
        managed: true,
        denyPolicy: true,
        quota: true,
        podSecurity: 'baseline',
        ...options.shape
      };
    },
    async createPod(namespace, pod) {
      pods[`${namespace}/${pod.name}`] = pod;
    },
    async podState(namespace, name): Promise<PodState> {
      if (name === 'listener') {
        const ip =
          options.listenerIp === undefined
            ? `10.1.${namespace.endsWith('a') ? 1 : 2}.5`
            : options.listenerIp;
        return { phase: ip ? 'Running' : 'Pending', ip, detail: ip ? '' : 'ImagePullBackOff' };
      }
      return { phase: options.probePhase ?? 'Succeeded', ip: null, detail: '' };
    },
    async podLog(namespace, name) {
      if (options.logThrows) throw new Error('log stream failed');
      const pod = pods[`${namespace}/${name}`];
      const targets = pod.env?.PROBE_TARGETS ?? '';
      return options.probeLog
        ? options.probeLog(targets)
        : targets
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [id, kind, host, port] = line.split(' ');
              const control =
                namespace.endsWith('-b') ||
                kind === 'dns' ||
                host === '1.1.1.1' ||
                host === '10.1.1.5' ||
                (host === '10.244.0.9' && port === '80');
              return `RESULT ${id} ${control ? 'open' : 'timeout'}`;
            })
            .join('\n') + '\nDONE\n';
    },
    async discover(sameIp, otherIp) {
      if (options.failDiscover) throw new Error('cannot list nodes');
      return topology({
        sameNamespaceListener: { ip: sameIp, port: LISTENER_PORT },
        otherTenantListener: { ip: otherIp, port: LISTENER_PORT }
      });
    },
    async deleteNamespace(name) {
      deleted.push(name);
      if (!(options.stuckDelete ?? []).includes(name)) namespaces.delete(name);
    },
    async namespaceExists(name) {
      return namespaces.has(name);
    },
    async listSelfTestNamespaces() {
      return [...namespaces.entries()]
        .filter(
          ([, v]) =>
            v.labels['orchard.my/selftest'] !== undefined || (options.existing ?? []).length > 0
        )
        .map(([name, v]) => ({ name, createdAt: v.createdAt }));
    }
  };
  return { cluster, namespaces, pods, deleted };
}

function service(fake: ReturnType<typeof fakeCluster>) {
  const svc = new SelfTestService(
    { create: () => fake.cluster } as any,
    { canCoordinate: false } as any
  );
  svc.timeouts = { listenerMs: 200, probeMs: 200, deleteMs: 100, pollMs: 5 };
  return svc;
}

async function run(svc: SelfTestService) {
  const started = svc.start('user-1');
  await svc.whenDone(started.id);
  return svc.get(started.id)!;
}

test('a clean run creates two tenant namespaces, probes, and leaves nothing behind', async () => {
  const fake = fakeCluster();
  const result = await run(service(fake));
  assert.equal(result.status, 'done');
  assert.equal(fake.namespaces.size, 0);
  assert.deepEqual(result.leftovers, []);
  assert.equal(result.checks.find((c) => c.id === 'selftest-namespace-shape')!.status, 'pass');
  assert.equal(result.checks.find((c) => c.id === 'selftest-controls')!.status, 'pass');
  assert.equal(result.checks.find((c) => c.id === 'selftest-cross-tenant')!.status, 'pass');
  assert.equal(result.summary.fail, 0);
  assert.ok(result.finishedAt);
  assert.ok(result.targets.length > 10);
  assert.ok(Object.keys(fake.pods).some((k) => k.endsWith('-b/probe')));
});

test('the temporary namespaces carry the reaper label with the run id', async () => {
  const fake = fakeCluster();
  const svc = service(fake);
  const seen: Record<string, string>[] = [];
  const original = fake.cluster.createTenantNamespace;
  fake.cluster.createTenantNamespace = async (name, labels) => {
    seen.push(labels);
    return original(name, labels);
  };
  const result = await run(svc);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((l) => l['orchard.my/selftest'] === result.id));
});

test('cleanup runs when the probe fails, and a failed run reports the error', async () => {
  const fake = fakeCluster({ failDiscover: true });
  const result = await run(service(fake));
  assert.equal(result.status, 'error');
  assert.match(result.error!, /cannot list nodes/);
  assert.equal(fake.namespaces.size, 0);
  assert.equal(fake.deleted.length >= 2, true);
});

test('cleanup runs when namespace creation fails halfway', async () => {
  const fake = fakeCluster();
  const probe = service(fake);
  fake.cluster.createTenantNamespace = async (name) => {
    if (name.endsWith('-b')) throw new Error('quota apply failed');
    fake.namespaces.set(name, { labels: {}, createdAt: Date.now() });
  };
  const result = await run(probe);
  assert.equal(result.status, 'error');
  assert.equal(fake.namespaces.size, 0);
});

test('a namespace that will not delete is reported as a leftover and left to the reaper', async () => {
  const fake = fakeCluster();
  const probe = service(fake);
  let stuck = '';
  const original = fake.cluster.createTenantNamespace;
  fake.cluster.createTenantNamespace = async (name, labels) => {
    if (name.endsWith('-a')) stuck = name;
    return original(name, labels);
  };
  const result = await (async () => {
    const started = probe.start(null);
    fake.cluster.deleteNamespace = async (name) => {
      fake.deleted.push(name);
      if (name !== stuck) fake.namespaces.delete(name);
    };
    await probe.whenDone(started.id);
    return probe.get(started.id)!;
  })();
  assert.deepEqual(result.leftovers, [stuck]);
  assert.match(result.notes.join(' '), /Cleanup incomplete/);
});

test('positive control failure yields unknown checks, not pass', async () => {
  const fake = fakeCluster({
    probeLog: (targets) =>
      targets
        .split('\n')
        .filter(Boolean)
        .map((line) => `RESULT ${line.split(' ')[0]} timeout`)
        .join('\n') + '\nDONE\n'
  });
  const result = await run(service(fake));
  assert.equal(result.status, 'done');
  assert.equal(result.checks.find((c) => c.id === 'selftest-controls')!.status, 'unknown');
  for (const id of [
    'selftest-apiserver',
    'selftest-nodes',
    'selftest-platform',
    'selftest-cross-tenant'
  ]) {
    assert.equal(result.checks.find((c) => c.id === id)!.status, 'unknown', id);
  }
  assert.equal(fake.namespaces.size, 0);
});

test('a probe pod that never finishes or whose log cannot be read is unknown, and cleanup still runs', async () => {
  for (const options of [{ probePhase: 'Pending' }, { logThrows: true }]) {
    const fake = fakeCluster(options);
    const result = await run(service(fake));
    assert.equal(result.checks.find((c) => c.id === 'selftest-nodes')!.status, 'unknown');
    assert.equal(fake.namespaces.size, 0);
  }
});

test('listeners without addresses abort the probe as unknown and clean up', async () => {
  const fake = fakeCluster({ listenerIp: null });
  const result = await run(service(fake));
  assert.equal(result.status, 'done');
  assert.ok(
    result.checks.every((c) => c.id === 'selftest-namespace-shape' || c.status === 'unknown')
  );
  assert.equal(fake.namespaces.size, 0);
  assert.ok(Object.keys(fake.pods).every((k) => !k.endsWith('/probe')));
});

test('a namespace that is not shaped like a tenant fails the shape check', async () => {
  const fake = fakeCluster({ shape: { denyPolicy: false, podSecurity: null } });
  const result = await run(service(fake));
  const shape = result.checks.find((c) => c.id === 'selftest-namespace-shape')!;
  assert.equal(shape.status, 'fail');
  assert.match(shape.evidence, /default-deny-all/);
});

test('a reachable platform address fails the run', async () => {
  const fake = fakeCluster({
    probeLog: (targets) =>
      targets
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, kind, host, port] = line.split(' ');
          const open =
            kind === 'dns' ||
            host === '1.1.1.1' ||
            host === '10.1.1.5' ||
            (host === '10.244.0.9' && port === '80') ||
            host === '10.96.1.2';
          return `RESULT ${id} ${open ? 'open' : 'timeout'}`;
        })
        .join('\n') + '\nDONE\n'
  });
  const result = await run(service(fake));
  assert.equal(result.checks.find((c) => c.id === 'selftest-platform')!.status, 'fail');
  assert.equal(result.summary.fail >= 1, true);
});

test('only one run at a time', async () => {
  const fake = fakeCluster();
  const svc = service(fake);
  const first = svc.start(null);
  assert.throws(() => svc.start(null), ConflictException);
  await svc.whenDone(first.id);
  const second = svc.start(null);
  await svc.whenDone(second.id);
  assert.notEqual(first.id, second.id);
  assert.equal(svc.latestFinished()?.id, second.id);
});

test('the reaper deletes old labelled namespaces and spares fresh ones', async () => {
  const now = Date.now();
  const fake = fakeCluster({
    existing: [
      { name: 'orchard-selftest-old-a', createdAt: now - 30 * 60_000 },
      { name: 'orchard-selftest-new-a', createdAt: now - 60_000 }
    ]
  });
  const svc = service(fake);
  const reaped = await svc.reapOrphans();
  assert.deepEqual(reaped, ['orchard-selftest-old-a']);
  assert.ok(fake.namespaces.has('orchard-selftest-new-a'));
});

test('a run reaps stale namespaces from an earlier crashed run before starting', async () => {
  const fake = fakeCluster({
    existing: [{ name: 'orchard-selftest-dead-a', createdAt: Date.now() - 60 * 60_000 }]
  });
  const result = await run(service(fake));
  assert.equal(result.status, 'done');
  assert.ok(fake.deleted.includes('orchard-selftest-dead-a'));
  assert.equal(fake.namespaces.size, 0);
});
