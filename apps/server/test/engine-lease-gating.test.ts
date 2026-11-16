import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as k8s from '@kubernetes/client-node';
import { EngineService } from '../src/engine/engine.service';
import { GLOBAL_LEADER_LEASE } from '../src/coordination/lease.service';

const ME = 'replica-a';

class FakeElector extends EventEmitter {
  holding = false;
  started = 0;
  resigned = 0;
  constructor(
    readonly name: string,
    readonly opts: any
  ) {
    super();
  }
  isHolder() {
    return this.holding;
  }
  start() {
    this.started += 1;
  }
  async stop() {}
  async resign() {
    this.resigned += 1;
    this.set(false);
  }
  set(value: boolean) {
    if (this.holding === value) return;
    this.holding = value;
    this.emit(value ? 'acquired' : 'lost');
  }
}

type Opts = {
  kc?: boolean;
  canCoordinate?: boolean;
  globalLeader?: boolean;
  clusterUid?: () => Promise<string>;
  otherReplicas?: string[];
};

function harness(opts: Opts = {}) {
  const calls = {
    registered: [] as string[],
    onAcquired: [] as string[],
    heartbeats: [] as any[],
    heartbeatUpdates: [] as any[],
    heartbeatDeletes: [] as any[],
    transitionsPruned: 0,
    consumer: [] as string[],
    k8s: [] as string[],
    transactions: 0
  };
  const electors = new Map<string, FakeElector>();
  const lease = {
    get canCoordinate() {
      return opts.canCoordinate ?? true;
    },
    replicaIdentity: ME,
    register: (name: string, o: any) => {
      calls.registered.push(name);
      const e = new FakeElector(name, o);
      electors.set(name, e);
      return e;
    },
    isHolder: (name: string) =>
      name === GLOBAL_LEADER_LEASE
        ? Boolean(opts.globalLeader)
        : (electors.get(name)?.isHolder() ?? false),
    onAcquired: (name: string) => {
      calls.onAcquired.push(name);
    }
  };
  const fresh = new Date();
  const prisma: any = {
    $transaction: async (fn: any) => {
      calls.transactions += 1;
      return fn({ $executeRaw: async () => 0 });
    },
    k8sMirrorHeartbeat: {
      upsert: async (args: any) => {
        calls.heartbeats.push(args);
        return {};
      },
      findMany: async () =>
        [ME, ...(opts.otherReplicas ?? [])].map((r) => ({
          shard: `replica:${r}`,
          updatedAt: fresh
        })),
      updateMany: async (args: any) => {
        calls.heartbeatUpdates.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: any) => {
        calls.heartbeatDeletes.push(args);
        return { count: 0 };
      }
    },
    podTransition: {
      deleteMany: async () => {
        calls.transitionsPruned += 1;
        return { count: 0 };
      }
    }
  };
  const api = new Proxy(
    {},
    {
      get: (_t, method: string) => async () => {
        calls.k8s.push(method);
        if (method === 'readNamespace') return { body: { metadata: { uid: 'cluster-uid' } } };
        throw Object.assign(new Error('not found'), { response: { statusCode: 404 } });
      }
    }
  );
  const kc = { makeApiClient: (_cls: unknown) => api } as unknown as k8s.KubeConfig;
  const kubernetes = { kc: opts.kc === false ? null : kc, isCiliumAvailable: async () => false };
  const consumer = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          calls.consumer.push(`${name}.${method}`);
        }
      }
    );
  const orgEvents = { watchedOrgIds: () => [], emitLocal: () => {} };
  const svc = new EngineService(
    kubernetes as any,
    prisma,
    lease as any,
    orgEvents as any,
    consumer('pods') as any,
    consumer('cnpg') as any,
    consumer('jobs') as any,
    consumer('cronJobs') as any,
    consumer('workloads') as any,
    consumer('ingresses') as any,
    consumer('storage') as any,
    consumer('services') as any,
    consumer('namespaces') as any,
    consumer('guard') as any,
    consumer('events') as any,
    consumer('scans') as any
  );
  if (opts.clusterUid) (svc as any).clusterUid = opts.clusterUid;
  return { svc, calls, electors, prisma, opts };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const sweeps = [
  'sweepCrashStates',
  'sweepVolumes',
  'checkTenantPolicies',
  'rebuildPodRows',
  'sampleDatabaseStats',
  'retention'
] as const;

async function runSweeps(svc: EngineService) {
  for (const name of sweeps) await (svc as any)[name]();
}

function fakeInformer(log: string[], name: string) {
  return {
    stop: async () => {
      log.push(`stop:${name}`);
    },
    resync: async () => {
      log.push(`resync:${name}`);
      return 0;
    }
  };
}

test('a process with a kubeconfig but no control namespace runs no mirror work at all', async () => {
  const { svc, calls } = harness({ canCoordinate: false });
  await svc.onApplicationBootstrap();
  await flush();
  assert.deepEqual(calls.registered, []);
  assert.deepEqual(calls.onAcquired, []);
  assert.deepEqual(calls.heartbeats, []);
  assert.deepEqual(calls.k8s, []);
  assert.equal(calls.transactions, 0);
  assert.deepEqual((svc as any).timers, []);
  assert.deepEqual(svc.heldShards(), []);
  await svc.onModuleDestroy();
});

test('without a kubeconfig the engine stays off', async () => {
  const { svc, calls } = harness({ kc: false });
  await svc.onApplicationBootstrap();
  await flush();
  assert.deepEqual(calls.registered, []);
  assert.deepEqual((svc as any).timers, []);
});

test('ENGINE_DISABLED keeps the engine off even on a coordinating cluster member', async () => {
  for (const key of ['ENGINE_DISABLED', 'MIRROR_DISABLED']) {
    const saved = process.env[key];
    process.env[key] = 'true';
    try {
      const { svc, calls } = harness();
      await svc.onApplicationBootstrap();
      await flush();
      assert.deepEqual(calls.registered, [], key);
      assert.deepEqual(calls.k8s, [], key);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
});

test('an engine that never turned on writes no presence and does no balancing', async () => {
  const { svc, calls } = harness({ canCoordinate: false, globalLeader: true });
  await svc.onApplicationBootstrap();
  await (svc as any).upsertPresence();
  await (svc as any).balance();
  await (svc as any).sweepCrashStates();
  await (svc as any).sweepVolumes();
  await (svc as any).checkTenantPolicies();
  await (svc as any).rebuildPodRows();
  await (svc as any).sampleDatabaseStats();
  assert.deepEqual(calls.heartbeats, []);
  assert.deepEqual(calls.consumer, []);
});

test('shard leases are registered without auto-start, one per shard', async () => {
  const { svc, calls, electors } = harness({ clusterUid: () => new Promise(() => {}) });
  await svc.onApplicationBootstrap();
  assert.ok(calls.registered.length >= 5);
  assert.equal(new Set(calls.registered).size, calls.registered.length);
  for (const e of electors.values()) {
    assert.equal(e.opts.autoStart, false, e.name);
    assert.equal(typeof e.opts.shouldAcquire, 'function', e.name);
  }
  assert.deepEqual(calls.onAcquired, [GLOBAL_LEADER_LEASE]);
  await svc.onModuleDestroy();
});

test('no shard lease is contested until the mirror is confirmed to belong to this cluster', async () => {
  let confirm!: (uid: string) => void;
  const { svc, calls, electors } = harness({
    clusterUid: () =>
      new Promise((r) => {
        confirm = r;
      })
  });
  await svc.onApplicationBootstrap();
  await flush();
  for (const e of electors.values()) assert.equal(e.started, 0, e.name);
  assert.deepEqual(calls.heartbeats, []);
  confirm('cluster-uid');
  await flush();
  for (const e of electors.values()) assert.equal(e.started, 1, e.name);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.heartbeats[0].where.shard, `replica:${ME}`);
  await svc.onModuleDestroy();
});

test('a mirror whose cluster cannot be identified keeps every shard lease uncontested', async () => {
  const { svc, calls, electors } = harness({
    clusterUid: async () => {
      throw new Error('apiserver unreachable');
    }
  });
  await svc.onApplicationBootstrap();
  await flush();
  for (const e of electors.values()) assert.equal(e.started, 0, e.name);
  assert.deepEqual(calls.heartbeats, []);
  await svc.onModuleDestroy();
});

test('the real cluster identity check reads the cluster identity namespace uid', async () => {
  const { svc, calls, electors } = harness();
  await svc.onApplicationBootstrap();
  await flush();
  assert.ok(calls.k8s.includes('readNamespace'));
  for (const e of electors.values()) assert.equal(e.started, 1, e.name);
  await svc.onModuleDestroy();
});

test('leader-only sweeps do nothing on a replica without the global lease', async () => {
  const { svc, calls } = harness({ globalLeader: false });
  (svc as any).enabled = true;
  await runSweeps(svc);
  assert.deepEqual(calls.consumer, []);
  assert.equal(calls.transitionsPruned, 0);
  assert.deepEqual(calls.heartbeatDeletes, []);
});

test('leader-only sweeps run on the replica holding the global lease', async () => {
  const { svc, calls } = harness({ globalLeader: true });
  (svc as any).enabled = true;
  await runSweeps(svc);
  assert.deepEqual(calls.consumer.sort(), [
    'cnpg.rebuildPodRows',
    'cnpg.sampleAllStats',
    'cnpg.sweepCrashStates',
    'cnpg.sweepVolumes',
    'events.prune',
    'guard.checkTenantPolicies',
    'pods.sweepCrashStates'
  ]);
  assert.equal(calls.transitionsPruned, 1);
  assert.equal(calls.heartbeatDeletes.length, 1);
});

test('losing the global lease stops the next round of sweeps', async () => {
  const h = harness({ globalLeader: true });
  (h.svc as any).enabled = true;
  await runSweeps(h.svc);
  const ran = h.calls.consumer.length;
  h.opts.globalLeader = false;
  await runSweeps(h.svc);
  assert.equal(h.calls.consumer.length, ran);
});

test('the leader-acquired pass still checks the lease before rebuilding pods', async () => {
  const { svc, calls } = harness({ globalLeader: false });
  (svc as any).enabled = true;
  await (svc as any).rebuildPodRows();
  await (svc as any).sweepVolumes();
  assert.deepEqual(calls.consumer, []);
});

async function booted(opts: Opts = {}) {
  const h = harness(opts);
  await h.svc.onApplicationBootstrap();
  await flush();
  const runtimes: Map<string, any> = (h.svc as any).shards;
  for (const r of runtimes.values()) r.def = { ...r.def, resources: [] };
  return { ...h, runtimes };
}

test('acquiring a shard lease starts only that shard', async () => {
  const { svc, calls, electors, runtimes } = await booted();
  const [first, second] = [...electors.values()];
  first.set(true);
  await flush();
  const shard = [...runtimes.values()].find((r) => r.elector === first);
  const other = [...runtimes.values()].find((r) => r.elector === second);
  assert.ok(shard.resyncTimer);
  assert.equal(other.resyncTimer, undefined);
  assert.deepEqual(
    calls.heartbeats.filter((h) => !h.where.shard.startsWith('replica:')).map((h) => h.where.shard),
    [shard.def.name]
  );
  assert.equal(calls.heartbeats.at(-1).create.holder, ME);
  assert.deepEqual(svc.heldShards(), [shard.def.name]);
  await svc.onModuleDestroy();
});

test('losing a shard lease stops its watches and releases only a heartbeat this replica holds', async () => {
  const { svc, calls, electors, runtimes } = await booted();
  const elector = [...electors.values()][0];
  const runtime = [...runtimes.values()].find((r) => r.elector === elector);
  elector.set(true);
  await flush();
  const log: string[] = [];
  runtime.informers = [fakeInformer(log, 'a'), fakeInformer(log, 'b')];
  elector.set(false);
  await flush();
  assert.deepEqual(log, ['stop:a', 'stop:b']);
  assert.deepEqual(runtime.informers, []);
  assert.equal(runtime.resyncTimer, undefined);
  assert.deepEqual(calls.heartbeatUpdates.at(-1), {
    where: { shard: runtime.def.name, holder: ME },
    data: { holder: null }
  });
  assert.deepEqual(svc.heldShards(), []);
  await svc.onModuleDestroy();
});

test('resync does nothing for a shard this replica does not hold', async () => {
  const { svc, calls, electors, runtimes } = await booted();
  const elector = [...electors.values()][0];
  const runtime = [...runtimes.values()].find((r) => r.elector === elector);
  const log: string[] = [];
  runtime.informers = [fakeInformer(log, 'a')];
  assert.equal(await svc.resyncShard(runtime.def.name), 0);
  assert.equal(await svc.resyncShard('no-such-shard'), 0);
  assert.deepEqual(log, []);
  assert.deepEqual(calls.heartbeatUpdates, []);
  elector.holding = true;
  await svc.resyncShard(runtime.def.name);
  assert.deepEqual(log, ['resync:a']);
  runtime.informers = [];
  await svc.onModuleDestroy();
});

test('heartbeats are only written for shards this replica holds', async () => {
  const { svc, calls, electors, runtimes } = await booted();
  const elector = [...electors.values()][1];
  elector.holding = true;
  const before = calls.heartbeats.length;
  await (svc as any).flushHeartbeats();
  const written = calls.heartbeats.slice(before).map((h) => h.where.shard);
  const runtime = [...runtimes.values()].find((r) => r.elector === elector);
  assert.deepEqual(written, [runtime.def.name]);
  await svc.onModuleDestroy();
});

test('a replica stops contending for shards once it holds its share of them', async () => {
  const { svc, electors } = await booted({ otherReplicas: ['replica-b'] });
  await (svc as any).refreshPresence();
  const all = [...electors.values()];
  const cap = Math.ceil(all.length / 2);
  assert.equal(all[0].opts.shouldAcquire(), true);
  for (const e of all.slice(0, cap)) e.holding = true;
  for (const e of all.slice(cap)) assert.equal(e.opts.shouldAcquire(), false, e.name);
  await svc.onModuleDestroy();
});

test('when another replica appears the holder resigns shards above its fair share', async () => {
  const { svc, electors } = await booted({ otherReplicas: ['replica-b'] });
  const all = [...electors.values()];
  for (const e of all) e.holding = true;
  await (svc as any).balance();
  const cap = Math.ceil(all.length / 2);
  assert.equal(svc.heldShards().length, cap);
  assert.equal(all.filter((e) => e.resigned > 0).length, all.length - cap);
  await svc.onModuleDestroy();
});

test('a shard handed over for being unhealthy is not re-acquired during its cooldown', async () => {
  const { svc, electors, runtimes } = await booted({ otherReplicas: ['replica-b'] });
  const elector = [...electors.values()][0];
  const runtime = [...runtimes.values()].find((r) => r.elector === elector);
  elector.holding = true;
  runtime.activity.unhealthy.set('Pod', { error: 'watch down', since: Date.now() - 10 * 60_000 });
  await (svc as any).balance();
  assert.equal(elector.resigned, 1);
  assert.equal(elector.isHolder(), false);
  assert.equal(elector.opts.shouldAcquire(), false);
  await svc.onModuleDestroy();
});

test('a lone unhealthy replica keeps its shard rather than leaving it unheld', async () => {
  const { svc, electors, runtimes } = await booted();
  const elector = [...electors.values()][0];
  const runtime = [...runtimes.values()].find((r) => r.elector === elector);
  elector.holding = true;
  runtime.activity.unhealthy.set('Pod', { error: 'watch down', since: Date.now() - 10 * 60_000 });
  await (svc as any).balance();
  assert.equal(elector.resigned, 0);
  assert.equal(elector.isHolder(), true);
  await svc.onModuleDestroy();
});

test('shutting down stops every running shard', async () => {
  const { svc, electors, runtimes } = await booted();
  const log: string[] = [];
  for (const [i, e] of [...electors.values()].entries()) {
    e.holding = true;
    [...runtimes.values()].find((r) => r.elector === e).informers = [fakeInformer(log, String(i))];
  }
  await svc.onModuleDestroy();
  assert.equal(log.length, electors.size);
  assert.deepEqual(svc.heldShards().length, electors.size);
  for (const r of runtimes.values()) assert.deepEqual(r.informers, []);
});
