import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_STATS_SCRIPT,
  KUBERNETES_USAGE_TTL_MS,
  SandboxUsageService,
  UsageRow,
  VERCEL_DISK_BYTES,
  VERCEL_USAGE_TTL_MS,
  parseGuestStats
} from '../src/sandboxes/sandbox-usage.service';
import { SandboxUsageController } from '../src/sandboxes/sandbox-usage.controller';
import { SandboxMinRole, SandboxRoleOptions } from '../src/sandboxes/sandbox-access.service';

process.env.SANDBOX_IDLE_TIMEOUT_MINUTES = '60';
process.env.SANDBOX_MAX_LIFETIME_HOURS = '168';
delete process.env.MIRROR_DISABLED;

const ID = '11111111-1111-4111-8111-111111111111';
const NS = 'orchard-sandboxes';
const POD = `sbx-${ID}`;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const GIB = 1024 ** 3;

const NET_DEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0',
  '  eth0: 1000000 10 0 0 0 0 0 0 250000 5 0 0 0 0 0 0'
];

function guestOut(parts: {
  first: string[];
  last: string[];
  nproc?: string;
  memory: string[];
  df?: string;
}): string {
  return [
    ...parts.first,
    '---',
    parts.df ?? '5368709120 68719476736',
    '---',
    '100',
    '---',
    ...NET_DEV,
    '---',
    parts.nproc ?? '4',
    '---',
    ...parts.memory,
    '---',
    ...parts.last
  ].join('\n');
}

const VM_FIRST = ['cpu  1200 30 270 90000 10 0 0 50 0 0', 'uptime 1000.00', 'usage_usec 15000000'];
const VM_LAST = ['cpu  1240 30 280 90150 10 0 0 50 0 0', 'uptime 1000.50', 'usage_usec 15500000'];
const VM_MEMORY = ['MemTotal:        8000000 kB', 'MemAvailable:    6951424 kB'];

const GUEST_OUT = guestOut({ first: VM_FIRST, last: VM_LAST, memory: VM_MEMORY });

const CONTAINER_OUT = guestOut({
  first: [
    'cpu  880000 1200 300000 9000000 4000 0 2000 0 0 0',
    'uptime 86400.10',
    'usage_usec 92000000'
  ],
  last: [
    'cpu  880600 1200 300200 9006400 4000 0 2000 0 0 0',
    'uptime 86400.60',
    'usage_usec 92210000'
  ],
  nproc: '16',
  memory: [
    'MemTotal:       65536000 kB',
    'MemAvailable:   40000000 kB',
    'memory.current 2147483648',
    'memory.max 4294967296',
    'cpu.max 200000 100000',
    'inactive_file 536870912'
  ]
});

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: ID,
    userId: 'owner',
    runner: 'kubernetes',
    podName: POD,
    namespace: NS,
    externalId: null,
    runnerState: null,
    status: 'running',
    desiredState: 'running',
    startedAt: new Date(NOW - 2 * 3600_000 - 5 * 60_000),
    lastActiveAt: new Date(NOW - 18 * 60_000),
    cpuLimit: '2',
    memoryLimit: '4Gi',
    diskSize: '10Gi',
    ...overrides
  };
}

const CR = {
  spec: {
    podTemplate: {
      spec: {
        containers: [
          {
            name: 'sandbox',
            resources: {
              requests: { cpu: '250m', memory: '512Mi' },
              limits: { cpu: '2', memory: '4Gi' }
            }
          }
        ]
      }
    }
  }
};

function pod() {
  return {
    metadata: { name: POD, labels: { 'orchard.my/sandbox-id': ID } },
    spec: {
      nodeName: 'house',
      containers: [
        {
          name: 'sandbox',
          resources: { requests: { cpu: '500m' }, limits: { cpu: '3', memory: '6Gi' } }
        }
      ],
      volumes: [{ name: 'home', persistentVolumeClaim: { claimName: `home-${POD}` } }]
    },
    status: { phase: 'Running' }
  };
}

function claim(volumeMode: 'Filesystem' | 'Block' = 'Filesystem') {
  return {
    metadata: { name: `home-${POD}` },
    spec: { volumeMode, resources: { requests: { storage: '10Gi' } } },
    status: { capacity: { storage: '10Gi' } }
  };
}

interface Harness {
  svc: SandboxUsageService;
  queries: string[];
  execs: string[][];
  summaries: string[];
  sdkCalls: Record<string, unknown>[];
  advance(ms: number): void;
}

function harness(opts: {
  pod?: Record<string, unknown> | null;
  claim?: Record<string, unknown> | null;
  cr?: Record<string, unknown> | null;
  vm?: (q: string) => number | null;
  summary?: () => unknown;
  exec?: () => { ok: boolean; stdout: string };
  sdk?: () => unknown;
  vercelConfig?: Record<string, string>;
  vercelError?: string | null;
  mirrorFails?: boolean;
  cap?: number | null;
}): Harness {
  const queries: string[] = [];
  const execs: string[][] = [];
  const summaries: string[] = [];
  const sdkCalls: Record<string, unknown>[] = [];
  const prisma = {
    k8sObject: {
      async findUnique() {
        if (opts.mirrorFails) throw new Error('db down');
        return opts.cr === null ? null : { manifest: opts.cr ?? CR };
      },
      async findMany(args: { where: { kind: string } }) {
        if (opts.mirrorFails) throw new Error('db down');
        if (args.where.kind === 'Pod') return opts.pod ? [{ manifest: opts.pod }] : [];
        return opts.claim ? [{ manifest: opts.claim }] : [];
      }
    },
    sandbox: {
      async count() {
        return 2;
      }
    }
  };
  const sandboxes = { sandboxCap: async () => (opts.cap === undefined ? 3 : opts.cap) };
  const kubernetes = { kc: {} };
  const metrics = {
    async queryInstant(q: string) {
      queries.push(q);
      return opts.vm ? opts.vm(q) : null;
    }
  };
  const settings: Record<string, string> = {
    vercelToken: 'tok',
    vercelTeamId: 'team',
    vercelProjectId: 'proj',
    ...opts.vercelConfig
  };
  const config = { value: (_section: unknown, name: string) => settings[name] ?? null };
  const exec = async (_ref: unknown, command: string[]) => {
    execs.push(command);
    if (!opts.exec) throw new Error('not running');
    return { ...opts.exec(), stderr: '', exitCode: 0 };
  };
  const kubernetesRunner = { namespace: NS, exec };
  const vercelRunner = {
    configError: () => opts.vercelError ?? null,
    exec,
    sdk: {
      async get(params: Record<string, unknown>) {
        sdkCalls.push(params);
        if (!opts.sdk) throw new Error('vercel down');
        return opts.sdk();
      }
    }
  };
  const svc = new SandboxUsageService(
    prisma as any,
    sandboxes as any,
    kubernetes as any,
    metrics as any,
    config as any,
    kubernetesRunner as any,
    vercelRunner as any
  );
  let clock = NOW;
  svc.now = () => clock;
  svc.kubeletSummary = async (node: string) => {
    summaries.push(node);
    if (!opts.summary) throw new Error('kubelet unreachable');
    return opts.summary();
  };
  return {
    svc,
    queries,
    execs,
    summaries,
    sdkCalls,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

const SUMMARY = {
  pods: [
    {
      volume: [
        {
          name: 'home',
          pvcRef: { namespace: NS, name: `home-${POD}` },
          usedBytes: 3 * GIB,
          capacityBytes: 9.8 * GIB,
          availableBytes: 6.8 * GIB
        }
      ]
    }
  ]
};

test('a running kubernetes machine reports live cpu, memory and disk against its pod limits', async () => {
  const h = harness({
    pod: pod(),
    claim: claim(),
    vm: (q) => (q.includes('cpu_usage') ? 420.4 : 1.5 * GIB),
    summary: () => SUMMARY
  });
  const usage = await h.svc.forSandbox(row());
  assert.deepEqual(usage.kubernetes, {
    cpu: { usedMillicores: 420, limitMillicores: 3000, requestMillicores: 500 },
    memory: { usedBytes: 1.5 * GIB, limitBytes: 6 * GIB },
    disk: { usedBytes: 3 * GIB, capacityBytes: 9.8 * GIB }
  });
  assert.equal(usage.vercel, null);
  assert.equal(usage.uptimeSeconds, 2 * 3600 + 5 * 60);
  assert.equal(usage.idleTimeoutMinutes, 60);
  assert.equal(usage.stopsAt, new Date(NOW + 42 * 60_000).toISOString());
  assert.equal(
    usage.lifetimeEndsAt,
    new Date(NOW - 2 * 3600_000 - 5 * 60_000 + 168 * 3600_000).toISOString()
  );
  assert.deepEqual(usage.machines, { count: 2, limit: 3 });
  assert.ok(h.queries.every((q) => q.includes(`pod="${POD}"`) && q.includes(`namespace="${NS}"`)));
  assert.deepEqual(h.summaries, ['house']);
  assert.equal(h.execs.length, 0);
});

test('kubernetes usage is cached for 15 seconds, then sampled again', async () => {
  const h = harness({ pod: pod(), claim: claim(), vm: () => 1, summary: () => SUMMARY });
  await h.svc.forSandbox(row());
  await h.svc.forSandbox(row());
  assert.equal(h.queries.length, 2);
  h.advance(KUBERNETES_USAGE_TTL_MS - 1);
  await h.svc.forSandbox(row());
  assert.equal(h.queries.length, 2);
  h.advance(2);
  const usage = await h.svc.forSandbox(row());
  assert.equal(h.queries.length, 4);
  assert.equal(usage.fetchedAt, new Date(NOW + KUBERNETES_USAGE_TTL_MS + 1).toISOString());
});

test('every missing kubernetes metric becomes null instead of an error', async () => {
  const h = harness({ pod: pod(), claim: claim() });
  const usage = await h.svc.forSandbox(row());
  assert.equal(h.execs.length, 1);
  assert.equal(usage.kubernetes?.cpu.usedMillicores, null);
  assert.equal(usage.kubernetes?.memory.usedBytes, null);
  assert.equal(usage.kubernetes?.disk.usedBytes, null);
  assert.equal(usage.kubernetes?.disk.capacityBytes, 10 * GIB);

  const broken = harness({ mirrorFails: true });
  const fallback = await broken.svc.forSandbox(row());
  assert.deepEqual(fallback.kubernetes, {
    cpu: { usedMillicores: null, limitMillicores: 2000, requestMillicores: null },
    memory: { usedBytes: null, limitBytes: 4 * GIB },
    disk: { usedBytes: null, capacityBytes: 10 * GIB }
  });
  assert.equal(broken.queries.length, 0);
});

test('a stopped machine has no countdowns and is never sampled', async () => {
  const h = harness({ pod: null, claim: claim(), vm: () => 5, summary: () => SUMMARY });
  const usage = await h.svc.forSandbox(
    row({ status: 'stopped', desiredState: 'stopped', startedAt: null })
  );
  assert.equal(usage.uptimeSeconds, null);
  assert.equal(usage.stopsAt, null);
  assert.equal(usage.lifetimeEndsAt, null);
  assert.equal(usage.kubernetes?.cpu.limitMillicores, 2000);
  assert.equal(usage.kubernetes?.cpu.requestMillicores, 250);
  assert.equal(h.queries.length, 0);
  assert.equal(h.summaries.length, 0);
  assert.equal(h.execs.length, 0);
});

test('a block-mode home disk is measured with df inside the machine, not the kubelet', async () => {
  const h = harness({
    pod: pod(),
    claim: claim('Block'),
    vm: () => null,
    exec: () => ({ ok: true, stdout: GUEST_OUT })
  });
  const usage = await h.svc.forSandbox(row());
  assert.deepEqual(usage.kubernetes?.disk, { usedBytes: 5 * GIB, capacityBytes: 64 * GIB });
  assert.equal(h.summaries.length, 0);
  assert.equal(h.execs.length, 1);
  assert.deepEqual(h.execs[0], ['/bin/sh', '-c', GUEST_STATS_SCRIPT, 'sh', '/persist']);
});

test('without metrics a kubernetes machine falls back to cpu and memory measured in its cgroup', async () => {
  const h = harness({
    pod: pod(),
    claim: claim(),
    summary: () => SUMMARY,
    exec: () => ({ ok: true, stdout: CONTAINER_OUT })
  });
  const usage = await h.svc.forSandbox(row());
  assert.deepEqual(usage.kubernetes, {
    cpu: { usedMillicores: 420, limitMillicores: 3000, requestMillicores: 500 },
    memory: { usedBytes: 1.5 * GIB, limitBytes: 6 * GIB },
    disk: { usedBytes: 3 * GIB, capacityBytes: 9.8 * GIB }
  });
  assert.equal(h.execs.length, 1);

  const partial = harness({
    pod: pod(),
    claim: claim(),
    vm: (q) => (q.includes('cpu_usage') ? 900 : null),
    summary: () => SUMMARY,
    exec: () => ({ ok: true, stdout: CONTAINER_OUT })
  });
  const mixed = await partial.svc.forSandbox(row());
  assert.equal(mixed.kubernetes?.cpu.usedMillicores, 900);
  assert.equal(mixed.kubernetes?.memory.usedBytes, 1.5 * GIB);
});

test('the guest fallback never runs past the lookup budget', async () => {
  const h = harness({
    pod: pod(),
    claim: claim(),
    vm: () => {
      h.advance(7_000);
      return null;
    },
    exec: () => ({ ok: true, stdout: CONTAINER_OUT })
  });
  const usage = await h.svc.forSandbox(row());
  assert.equal(h.execs.length, 0);
  assert.equal(usage.kubernetes?.cpu.usedMillicores, null);
});

test('the owner machine count is uncapped when the owner is a superadmin', async () => {
  const h = harness({ cap: null });
  const usage = await h.svc.forSandbox(row({ status: 'stopped', desiredState: 'stopped' }));
  assert.deepEqual(usage.machines, { count: 2, limit: null });
});

function vercelView(
  overrides: Record<string, unknown> = {},
  live: { activeCpuUsageMs?: number; networkTransfer?: { ingress: number; egress: number } } = {}
) {
  const view: Record<string, unknown> = {
    status: 'running',
    vcpus: 4,
    memory: 8192,
    timeout: 45 * 60_000,
    expiresAt: new Date(NOW + (3 * 60 + 12) * 60_000),
    totalActiveCpuDurationMs: 600_000,
    totalIngressBytes: 7_000_000,
    totalEgressBytes: 3_000_000,
    ...overrides
  };
  Object.defineProperty(view, 'activeCpuUsageMs', {
    get() {
      if (live.activeCpuUsageMs !== undefined) return live.activeCpuUsageMs;
      throw new Error('No active session. Run a command or call resume first.');
    }
  });
  Object.defineProperty(view, 'networkTransfer', { get: () => live.networkTransfer });
  return view;
}

test('a running vercel machine reports its allocation, session end and in-guest counters', async () => {
  const h = harness({ sdk: () => vercelView(), exec: () => ({ ok: true, stdout: GUEST_OUT }) });
  const usage = await h.svc.forSandbox(
    row({ runner: 'vercel', namespace: null, runnerState: { expiresAt: '2026-10-08T13:00:00Z' } })
  );
  assert.equal(usage.kubernetes, null);
  assert.deepEqual(usage.vercel, {
    vcpus: 4,
    memoryBytes: 8 * GIB,
    cpu: { usedCores: 1, totalCores: 4 },
    memory: { usedBytes: 1 * GIB, totalBytes: 8 * GIB },
    sessionExpiresAt: new Date(NOW + (3 * 60 + 12) * 60_000).toISOString(),
    sessionTimeoutMinutes: 45,
    activeCpuMs: 15_000,
    totalActiveCpuMs: 600_000,
    networkIngressBytes: 1_000_000,
    networkEgressBytes: 250_000,
    totalIngressBytes: 7_000_000,
    totalEgressBytes: 3_000_000,
    disk: { usedBytes: 5 * GIB, capacityBytes: 64 * GIB }
  });
  assert.equal(h.sdkCalls[0].name, POD);
  assert.equal(h.sdkCalls[0].resume, false);
  assert.equal(h.sdkCalls[0].token, 'tok');
  assert.deepEqual(h.execs[0], ['/bin/sh', '-c', GUEST_STATS_SCRIPT, 'sh', '/persist']);
});

test('provider counters win over the in-guest estimate once vercel reports them', async () => {
  const view = vercelView(
    {},
    { activeCpuUsageMs: 9_000, networkTransfer: { ingress: 11, egress: 22 } }
  );
  const h = harness({ sdk: () => view, exec: () => ({ ok: true, stdout: GUEST_OUT }) });
  const usage = await h.svc.forSandbox(row({ runner: 'vercel' }));
  assert.equal(usage.vercel?.activeCpuMs, 9_000);
  assert.equal(usage.vercel?.networkIngressBytes, 11);
  assert.equal(usage.vercel?.networkEgressBytes, 22);
});

test('vercel usage falls back to config and nulls when the API does not answer, and caches 30s', async () => {
  const h = harness({ vercelConfig: { vercelVcpus: '2', vercelTimeoutMinutes: '1440' } });
  const usage = await h.svc.forSandbox(
    row({ runner: 'vercel', runnerState: { expiresAt: '2026-10-08T13:00:00Z' } })
  );
  assert.deepEqual(usage.vercel, {
    vcpus: 2,
    memoryBytes: 4 * GIB,
    cpu: { usedCores: null, totalCores: 2 },
    memory: { usedBytes: null, totalBytes: 4 * GIB },
    sessionExpiresAt: '2026-10-08T13:00:00.000Z',
    sessionTimeoutMinutes: 1440,
    activeCpuMs: null,
    totalActiveCpuMs: null,
    networkIngressBytes: null,
    networkEgressBytes: null,
    totalIngressBytes: null,
    totalEgressBytes: null,
    disk: { usedBytes: null, capacityBytes: VERCEL_DISK_BYTES }
  });
  assert.equal(h.execs.length, 0);
  h.advance(VERCEL_USAGE_TTL_MS - 1);
  await h.svc.forSandbox(row({ runner: 'vercel' }));
  assert.equal(h.sdkCalls.length, 1);
  h.advance(2);
  await h.svc.forSandbox(row({ runner: 'vercel' }));
  assert.equal(h.sdkCalls.length, 2);
});

test('an unconfigured vercel runner never calls the API', async () => {
  const h = harness({ vercelError: 'Vercel sandboxes need vercelToken', sdk: () => vercelView() });
  const usage = await h.svc.forSandbox(row({ runner: 'vercel' }));
  assert.equal(h.sdkCalls.length, 0);
  assert.equal(usage.vercel?.disk.usedBytes, null);
});

test('guest stats parse df, busy jiffies, a sampled cpu window, memory and interface bytes', () => {
  assert.deepEqual(parseGuestStats(GUEST_OUT), {
    diskUsedBytes: 5 * GIB,
    diskSizeBytes: 64 * GIB,
    activeCpuMs: 15_000,
    rxBytes: 1_000_000,
    txBytes: 250_000,
    cpuUsedCores: 1,
    cpuCores: 4,
    memoryUsedBytes: 1 * GIB,
    memoryTotalBytes: 8_000_000 * 1024
  });
  assert.deepEqual(parseGuestStats(''), {
    diskUsedBytes: null,
    diskSizeBytes: null,
    activeCpuMs: null,
    rxBytes: null,
    txBytes: null,
    cpuUsedCores: null,
    cpuCores: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null
  });
});

test('a container is measured against its cgroup limits, not the host it shares', () => {
  const stats = parseGuestStats(CONTAINER_OUT);
  assert.equal(stats.cpuUsedCores, 0.42);
  assert.equal(stats.cpuCores, 2);
  assert.equal(stats.memoryUsedBytes, 1.5 * GIB);
  assert.equal(stats.memoryTotalBytes, 4 * GIB);
});

test('without cgroup counters cpu comes from the /proc/stat busy share across online cpus', () => {
  const noCgroup = (lines: string[]) => lines.filter((l) => !l.startsWith('usage_usec'));
  const stats = parseGuestStats(
    guestOut({
      first: noCgroup(VM_FIRST),
      last: noCgroup(VM_LAST),
      nproc: '2',
      memory: ['memory.current 100', 'memory.max max', 'cpu.max max 100000', ...VM_MEMORY]
    })
  );
  assert.equal(stats.cpuUsedCores, 0.5);
  assert.equal(stats.cpuCores, 2);
  assert.equal(stats.memoryUsedBytes, 1 * GIB);
  assert.equal(stats.memoryTotalBytes, 8_000_000 * 1024);
});

test('a guest that could not sample twice reports no cpu use rather than a guess', () => {
  const stats = parseGuestStats(
    guestOut({ first: VM_FIRST, last: [], memory: ['MemTotal:        8000000 kB'] })
  );
  assert.equal(stats.cpuUsedCores, null);
  assert.equal(stats.cpuCores, 4);
  assert.equal(stats.memoryUsedBytes, null);
  assert.equal(stats.memoryTotalBytes, 8_000_000 * 1024);
});

test('usage is lifecycle-level: viewers and uninvited org admins may read it', async () => {
  const calls: { min: SandboxMinRole; opts: SandboxRoleOptions }[] = [];
  const access = {
    async requireSandboxRole(_id: string, _user: string, min: SandboxMinRole, opts = {}) {
      calls.push({ min, opts });
      return { sandbox: row({ status: 'stopped', desiredState: 'stopped' }) };
    }
  };
  const users = { findOrCreateByClerkId: async () => ({ id: 'u1', email: null }) };
  const usageService = { forSandbox: async (r: UsageRow) => ({ id: r.id }) };
  const c = new SandboxUsageController(
    access as any,
    usageService as any,
    users as any,
    { configured: false } as any
  );
  const result = await c.usage({ user: { sub: 'u1' } }, ID);
  assert.deepEqual(result, { id: ID });
  assert.deepEqual(calls, [{ min: 'viewer', opts: { orgAdmin: true } }]);
});
