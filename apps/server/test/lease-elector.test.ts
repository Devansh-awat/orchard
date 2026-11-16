import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import { LeaseElector, StaticElector } from '../src/engine/core/lease-elector';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../src/coordination/lease.service';

const NS = 'orchard-system';
const NAME = 'orchard-global-leader';
const ME = 'replica-a';
const OTHER = 'replica-b';

type Lease = {
  metadata: { name: string; namespace: string; resourceVersion?: string };
  spec: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    renewTime?: Date;
    acquireTime?: Date;
    leaseTransitions?: number;
  };
};

const httpError = (statusCode: number) =>
  Object.assign(new Error(`status ${statusCode}`), { response: { statusCode } });

function cluster(
  opts: {
    lease?: Lease | null;
    readFails?: () => Error | null;
    replaceFails?: () => Error | null;
    createFails?: () => Error | null;
    pendingRead?: Promise<void>;
  } = {}
) {
  const state = { lease: opts.lease ?? null } as { lease: Lease | null };
  const calls = { reads: 0, replaces: [] as Lease[], creates: [] as any[] };
  const api = {
    readNamespacedLease: async (name: string, namespace: string) => {
      calls.reads += 1;
      assert.equal(name, NAME);
      assert.equal(namespace, NS);
      if (opts.pendingRead) await opts.pendingRead;
      const err = opts.readFails?.();
      if (err) throw err;
      if (!state.lease) throw httpError(404);
      return { body: structuredClone(state.lease) };
    },
    replaceNamespacedLease: async (_name: string, _ns: string, body: Lease) => {
      const err = opts.replaceFails?.();
      if (err) throw err;
      calls.replaces.push(structuredClone(body));
      state.lease = structuredClone(body);
      return { body };
    },
    createNamespacedLease: async (_ns: string, body: Lease) => {
      const err = opts.createFails?.();
      if (err) throw err;
      calls.creates.push(body);
      state.lease = structuredClone(body);
      return { body };
    }
  };
  const kc = {
    makeApiClient: (cls: unknown) => {
      assert.equal(cls, k8s.CoordinationV1Api);
      return api;
    }
  } as unknown as k8s.KubeConfig;
  return { kc, state, calls };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function elector(kc: k8s.KubeConfig, shouldAcquire?: () => boolean) {
  const e = new LeaseElector(kc, {
    namespace: NS,
    name: NAME,
    identity: ME,
    leaseDurationSeconds: 15,
    renewIntervalMs: 3_600_000,
    shouldAcquire,
    logger: quiet
  });
  const events: string[] = [];
  e.on('acquired', () => events.push('acquired'));
  e.on('lost', () => events.push('lost'));
  return { e, events, tick: () => (e as any).tick() as Promise<void> };
}

const held = (holder: string, ageMs: number, duration = 15): Lease => ({
  metadata: { name: NAME, namespace: NS, resourceVersion: '7' },
  spec: {
    holderIdentity: holder,
    leaseDurationSeconds: duration,
    renewTime: new Date(Date.now() - ageMs),
    leaseTransitions: 3
  }
});

const flush = () => new Promise((r) => setImmediate(r));

test('an elector that was never started holds nothing and calls nothing', async () => {
  const c = cluster();
  const { e, tick } = elector(c.kc);
  await tick();
  assert.equal(e.isHolder(), false);
  assert.equal(c.calls.reads, 0);
});

test('a missing lease is created and claimed by this replica', async () => {
  const c = cluster();
  const { e, events } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), true);
  assert.deepEqual(events, ['acquired']);
  assert.equal(c.calls.creates[0].spec.holderIdentity, ME);
  await e.stop();
});

test('a lease another replica renewed recently is never taken over', async () => {
  const c = cluster({ lease: held(OTHER, 2_000) });
  const { e, events, tick } = elector(c.kc);
  e.start();
  await flush();
  await tick();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, []);
  assert.deepEqual(c.calls.replaces, []);
  assert.equal(c.state.lease?.spec.holderIdentity, OTHER);
  await e.stop();
});

test('an expired lease held by another replica is taken over and its transitions counted', async () => {
  const c = cluster({ lease: held(OTHER, 16_000) });
  const { e, events } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), true);
  assert.deepEqual(events, ['acquired']);
  assert.equal(c.state.lease?.spec.holderIdentity, ME);
  assert.equal(c.state.lease?.spec.leaseTransitions, 4);
  assert.equal(c.calls.replaces[0].metadata.resourceVersion, '7');
  await e.stop();
});

test('a lease with an empty holder or no renew time is free to claim', async () => {
  for (const lease of [held('', 0), { ...held(OTHER, 0), spec: { holderIdentity: OTHER } }]) {
    const c = cluster({ lease });
    const { e } = elector(c.kc);
    e.start();
    await flush();
    assert.equal(e.isHolder(), true);
    await e.stop();
  }
});

test('a lease is judged expired by its own duration, not this replica default', async () => {
  const c = cluster({ lease: held(OTHER, 20_000, 60) });
  const { e } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), false);
  await e.stop();
});

test('losing a takeover race to another replica leaves this one without the lease', async () => {
  const c = cluster({ lease: held(OTHER, 30_000), replaceFails: () => httpError(409) });
  const { e, events } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, []);
  await e.stop();
});

test('two replicas racing to create the lease cannot both hold it', async () => {
  const c = cluster({ createFails: () => httpError(409) });
  const { e } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), false);
  await e.stop();
});

test('a replica that may not acquire more never claims a missing or expired lease', async () => {
  for (const lease of [null, held(OTHER, 60_000), held('', 0)]) {
    const c = cluster({ lease });
    const { e, events } = elector(c.kc, () => false);
    e.start();
    await flush();
    assert.equal(e.isHolder(), false);
    assert.deepEqual(events, []);
    assert.deepEqual(c.calls.creates, []);
    assert.deepEqual(c.calls.replaces, []);
    await e.stop();
  }
});

test('the holder keeps renewing its own lease even when it may not acquire more', async () => {
  const c = cluster({ lease: held(ME, 4_000) });
  const { e, tick } = elector(c.kc, () => false);
  e.start();
  await flush();
  assert.equal(e.isHolder(), true);
  await tick();
  assert.equal(c.calls.replaces.length, 2);
  assert.equal(c.state.lease?.spec.holderIdentity, ME);
  await e.stop();
});

test('the holder loses the lease as soon as another replica is seen holding it', async () => {
  const c = cluster();
  const { e, events, tick } = elector(c.kc);
  e.start();
  await flush();
  assert.equal(e.isHolder(), true);
  c.state.lease = held(OTHER, 0);
  await tick();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, ['acquired', 'lost']);
  await e.stop();
});

test('a conflicting renewal drops the lease at once', async () => {
  let conflict = false;
  const c = cluster({ replaceFails: () => (conflict ? httpError(409) : null) });
  const { e, events, tick } = elector(c.kc);
  e.start();
  await flush();
  conflict = true;
  await tick();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, ['acquired', 'lost']);
  await e.stop();
});

test('one failed renewal is tolerated and two in a row give the lease up', async () => {
  let failing = false;
  const c = cluster({ readFails: () => (failing ? new Error('apiserver unreachable') : null) });
  const { e, events, tick } = elector(c.kc);
  e.start();
  await flush();
  failing = true;
  await tick();
  assert.equal(e.isHolder(), true);
  await tick();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, ['acquired', 'lost']);
  await e.stop();
});

test('a successful renewal resets the failure count', async () => {
  let failing = false;
  const c = cluster({ readFails: () => (failing ? new Error('blip') : null) });
  const { e, tick } = elector(c.kc);
  e.start();
  await flush();
  failing = true;
  await tick();
  failing = false;
  await tick();
  failing = true;
  await tick();
  assert.equal(e.isHolder(), true);
  await e.stop();
});

test('stopping the holder releases the lease so another replica can take it at once', async () => {
  const c = cluster();
  const { e, events } = elector(c.kc);
  e.start();
  await flush();
  await e.stop();
  assert.equal(e.isHolder(), false);
  assert.deepEqual(events, ['acquired', 'lost']);
  assert.equal(c.state.lease?.spec.holderIdentity, '');
});

test('releasing never clears a lease that another replica now holds', async () => {
  const c = cluster();
  const { e } = elector(c.kc);
  e.start();
  await flush();
  c.state.lease = held(OTHER, 0);
  const replacesBefore = c.calls.replaces.length;
  await e.resign();
  assert.equal(e.isHolder(), false);
  assert.equal(c.state.lease?.spec.holderIdentity, OTHER);
  assert.equal(c.calls.replaces.length, replacesBefore);
  await e.stop();
});

test('resigning gives the lease up and a non-holder resign does nothing', async () => {
  const c = cluster();
  const { e, events } = elector(c.kc);
  await e.resign();
  assert.deepEqual(events, []);
  e.start();
  await flush();
  await e.resign();
  assert.equal(e.isHolder(), false);
  assert.equal(c.state.lease?.spec.holderIdentity, '');
  assert.deepEqual(events, ['acquired', 'lost']);
  await e.stop();
});

test('a failed release still marks this replica as no longer holding', async () => {
  let failing = false;
  const c = cluster({ readFails: () => (failing ? new Error('down') : null) });
  const { e } = elector(c.kc);
  e.start();
  await flush();
  failing = true;
  await e.stop();
  assert.equal(e.isHolder(), false);
});

test('a stopped elector does no more lease work', async () => {
  const c = cluster();
  const { e, tick } = elector(c.kc);
  e.start();
  await flush();
  await e.stop();
  const reads = c.calls.reads;
  await tick();
  assert.equal(c.calls.reads, reads);
  assert.equal(e.isHolder(), false);
});

test('starting twice does not run a second renewal loop', async () => {
  const c = cluster();
  const { e } = elector(c.kc);
  e.start();
  e.start();
  await flush();
  assert.equal(c.calls.reads, 1);
  await e.stop();
});

test.todo('a renewal still in flight when the elector stops does not claim the lease afterwards');

test.todo(
  'a holder whose renewals hang stops reporting itself as holder once its last renewal is older than the lease duration'
);

test('a static non-holder never acquires and a static holder announces itself once started', async () => {
  const never = new StaticElector(false);
  let fired = 0;
  never.on('acquired', () => (fired += 1));
  never.start();
  await flush();
  assert.equal(never.isHolder(), false);
  assert.equal(fired, 0);

  const always = new StaticElector(true);
  always.on('acquired', () => (fired += 1));
  assert.equal(fired, 0);
  always.start();
  await flush();
  assert.equal(fired, 1);
  assert.equal(always.isHolder(), true);
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test('a process with a kubeconfig but no control namespace can never hold a lease', async () => {
  await withEnv({ ORCHARD_CONTROL_NAMESPACE: undefined, NODE_ENV: 'development' }, async () => {
    const c = cluster();
    const svc = new LeaseService({ kc: c.kc } as any);
    assert.equal(svc.canCoordinate, false);
    let acquired = 0;
    svc.onAcquired(GLOBAL_LEADER_LEASE, () => (acquired += 1));
    const shard = svc.register('orchard-mirror-pods', { shouldAcquire: () => true });
    await flush();
    assert.equal(svc.isHolder(GLOBAL_LEADER_LEASE), false);
    assert.equal(shard.isHolder(), false);
    assert.equal(acquired, 0);
    assert.equal(c.calls.reads, 0);
    await svc.onApplicationShutdown();
  });
});

test('a production process without a kubeconfig holds no lease', async () => {
  await withEnv({ ORCHARD_CONTROL_NAMESPACE: undefined, NODE_ENV: 'production' }, async () => {
    const svc = new LeaseService({ kc: null } as any);
    svc.register(GLOBAL_LEADER_LEASE);
    await flush();
    assert.equal(svc.canCoordinate, false);
    assert.equal(svc.isHolder(GLOBAL_LEADER_LEASE), false);
  });
});

test('only a dev process with no cluster at all acts as sole holder', async () => {
  await withEnv({ ORCHARD_CONTROL_NAMESPACE: undefined, NODE_ENV: 'development' }, async () => {
    const svc = new LeaseService({ kc: null } as any);
    svc.register(GLOBAL_LEADER_LEASE);
    await flush();
    assert.equal(svc.canCoordinate, false);
    assert.equal(svc.isHolder(GLOBAL_LEADER_LEASE), true);
  });
});

test('with a kubeconfig and a control namespace the lease is contested in that namespace', async () => {
  await withEnv({ ORCHARD_CONTROL_NAMESPACE: NS }, async () => {
    const c = cluster({ lease: held(OTHER, 1_000) });
    const svc = new LeaseService({ kc: c.kc } as any);
    assert.equal(svc.canCoordinate, true);
    const e = svc.register(NAME, { renewIntervalMs: 3_600_000 });
    await flush();
    assert.ok(e instanceof LeaseElector);
    assert.equal(c.calls.reads, 1);
    assert.equal(svc.isHolder(NAME), false);
    await svc.onApplicationShutdown();
  });
});

test('registering a lease twice returns the same elector', async () => {
  await withEnv({ ORCHARD_CONTROL_NAMESPACE: NS }, async () => {
    const c = cluster({ lease: held(OTHER, 1_000) });
    const svc = new LeaseService({ kc: c.kc } as any);
    const a = svc.register(NAME, { autoStart: false });
    const b = svc.register(NAME, { shouldAcquire: () => true });
    assert.equal(a, b);
    await flush();
    assert.equal(c.calls.reads, 0);
    await svc.onApplicationShutdown();
  });
});

test('isHolder is false for a lease that was never registered', () => {
  const svc = new LeaseService({ kc: null } as any);
  assert.equal(svc.isHolder('nobody-registered-this'), false);
});
