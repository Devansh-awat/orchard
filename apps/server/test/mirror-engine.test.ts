import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { MirrorInformer } from '../src/mirror/mirror-informer';
import { PodMirrorConsumer } from '../src/mirror/consumers/pod-mirror.consumer';
import { computePodStatus } from '../src/mirror/pod-status';

const prisma = new PrismaClient();

const SHARD = 'test-mirror-shard';
const KIND = 'Ingress';
const API_VERSION = 'networking.k8s.io/v1';
const NS = 'test-mirror-ns';
const SLUG = 'test-mirror-org';

let projectId = '';
let deploymentId = '';
let otherDeploymentId = '';

interface FakeObject {
  metadata: { uid: string; name: string; namespace: string; resourceVersion: string };
  spec?: unknown;
}

function obj(uid: string, name: string, rv = '1'): FakeObject {
  return { metadata: { uid, name, namespace: NS, resourceVersion: rv }, spec: { uid } };
}

/** Objects the fake apiserver currently reports, and what the informer told consumers. */
let cluster: FakeObject[] = [];
let seenEvents: { type: string; name: string | undefined }[] = [];
let listCalls: (string | undefined)[] = [];
/** How the fake resource resolves its owners: to a deployment, to nothing, or not at all. */
let refsMode: 'owned' | 'unowned' | 'unresolvable' = 'unowned';
/** Names whose next handler call throws, standing in for a bad minute in the database. */
let failHandlerFor = new Set<string>();

function newInformer(): MirrorInformer {
  const config = {
    kind: KIND,
    apiVersion: API_VERSION,
    watchPath: '/apis/networking.k8s.io/v1/ingresses',
    list: async (_kc: unknown, opts: { limit: number; continueToken?: string }) => {
      listCalls.push(opts.continueToken);
      const start = opts.continueToken ? Number(opts.continueToken) : 0;
      const next = start + opts.limit;
      return {
        items: cluster.slice(start, next),
        resourceVersion: '9000',
        continueToken: next < cluster.length ? String(next) : null
      };
    },
    mapRefs: async () => {
      if (refsMode === 'unresolvable') throw new Error('database said no');
      return refsMode === 'owned' ? { deploymentId, projectId } : {};
    },
    onEvent: (type: string, o: any) => {
      const name = o?.metadata?.name;
      if (failHandlerFor.delete(name)) throw new Error(`handler blew up for ${name}`);
      seenEvents.push({ type, name });
    }
  };
  const informer = new MirrorInformer({} as never, prisma as never, SHARD, config as never, {
    onListed: () => {},
    onWatchEvent: () => {},
    onHealthChange: () => {}
  });
  // The tests drive list/sync directly rather than opening a real watch.
  (informer as unknown as { stopped: boolean }).stopped = false;
  return informer;
}

function listAndSync(informer: MirrorInformer) {
  return (
    informer as unknown as {
      listAndSync(count: boolean): Promise<{ resourceVersion: string; repairs: number }>;
    }
  ).listAndSync(false);
}

/** The watch's own entry point: queues the event rather than awaiting it. */
function dispatch(informer: MirrorInformer, phase: string, o: unknown) {
  (informer as unknown as { dispatch(phase: string, o: unknown): void }).dispatch(phase, o);
}

function drain(informer: MirrorInformer) {
  return (informer as unknown as { drain(): Promise<void> }).drain();
}

function handle(informer: MirrorInformer, phase: string, o: unknown) {
  return (informer as unknown as { handle(phase: string, o: unknown): Promise<void> }).handle(
    phase,
    o
  );
}

async function mirrored() {
  return prisma.k8sObject.findMany({
    where: { shard: SHARD },
    select: {
      uid: true,
      name: true,
      resourceVersion: true,
      derivedVersion: true,
      deploymentId: true,
      syncedAt: true
    },
    orderBy: { name: 'asc' }
  });
}

// --- crash state harness -----------------------------------------------------

let notified: { deploymentId: string; state: string; detail?: string }[] = [];

function newConsumer(): PodMirrorConsumer {
  return new PodMirrorConsumer(
    prisma as never,
    { emit: () => {} } as never,
    { capture: async () => {} } as never,
    {
      notifyPodState: async (id: string, state: string, detail?: string) => {
        notified.push({ deploymentId: id, state, detail });
      }
    } as never
  );
}

function podEvent(name: string, crashing: boolean, dep = 'test-mirror-dep') {
  return {
    metadata: {
      uid: `pod-${name}`,
      name,
      namespace: NS,
      resourceVersion: '1',
      labels: { 'app.kubernetes.io/name': dep }
    },
    spec: { nodeName: 'node-a' },
    status: {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [
        {
          name: 'app',
          ready: !crashing,
          restartCount: crashing ? 4 : 0,
          state: crashing
            ? { waiting: { reason: 'CrashLoopBackOff' } }
            : { running: { startedAt: new Date().toISOString() } },
          lastState: crashing
            ? {
                terminated: { reason: 'Error', exitCode: 137, finishedAt: new Date().toISOString() }
              }
            : {}
        }
      ]
    }
  };
}

/** Push crashingSince/healthySince into the past so debounce windows have elapsed. */
async function ageCrashState(ms: number) {
  const state = await prisma.deploymentCrashState.findUnique({ where: { deploymentId } });
  if (!state) return;
  await prisma.deploymentCrashState.update({
    where: { deploymentId },
    data: {
      crashingSince: state.crashingSince ? new Date(state.crashingSince.getTime() - ms) : null,
      healthySince: state.healthySince ? new Date(state.healthySince.getTime() - ms) : null
    }
  });
}

// --- fixtures ----------------------------------------------------------------

async function cleanup() {
  await prisma.k8sObject.deleteMany({ where: { shard: SHARD } });
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (org) await prisma.organization.delete({ where: { id: org.id } });
}

before(async () => {
  await cleanup();
  const org = await prisma.organization.create({
    data: { name: 'Test Mirror Org', slug: SLUG }
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: 'mirror', slug: 'mirror', namespace: NS }
  });
  projectId = project.id;
  const deployment = await prisma.deployment.create({
    data: { projectId, name: 'test-mirror-dep', namespace: NS }
  });
  deploymentId = deployment.id;
  const other = await prisma.deployment.create({
    data: { projectId, name: 'test-mirror-dep-b', namespace: NS }
  });
  otherDeploymentId = other.id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.k8sObject.deleteMany({ where: { shard: SHARD } });
  await prisma.deploymentCrashState.deleteMany({ where: { deploymentId } });
  await prisma.pod.deleteMany({
    where: { deploymentId: { in: [deploymentId, otherDeploymentId] } }
  });
  cluster = [];
  seenEvents = [];
  listCalls = [];
  notified = [];
  refsMode = 'unowned';
  failHandlerFor = new Set();
});

// --- informer ----------------------------------------------------------------

test('a paginated list mirrors every object and only asks the apiserver in pages', async () => {
  cluster = Array.from({ length: 550 }, (_, i) =>
    obj(`uid-${i}`, `ing-${String(i).padStart(4, '0')}`)
  );
  const informer = newInformer();

  await listAndSync(informer);

  assert.equal(await prisma.k8sObject.count({ where: { shard: SHARD } }), 550);
  // 550 objects at a 500-object page size is two requests: the first with no
  // continue token, the second resuming from it.
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0], undefined);
  assert.ok(listCalls[1]);
});

test('an unchanged object is not rewritten on relist', async () => {
  cluster = [obj('uid-a', 'ing-a', '5')];
  const informer = newInformer();
  await listAndSync(informer);
  seenEvents = [];

  await listAndSync(informer);

  assert.deepEqual(seenEvents, []);
  assert.equal((await mirrored())[0].resourceVersion, '5');
});

test('an owner that only resolves later is picked up without the object changing', async () => {
  // The pod arrives a moment before its deployment row is visible, resolves to
  // nothing, and then never changes again. Skipping it on resourceVersion alone
  // is what left a live app reading "pending" until somebody restarted it.
  refsMode = 'unowned';
  cluster = [obj('uid-a', 'ing-a', '5')];
  const informer = newInformer();
  await listAndSync(informer);
  assert.equal((await mirrored())[0].deploymentId, null);

  refsMode = 'owned';
  seenEvents = [];
  await listAndSync(informer);

  const row = (await mirrored())[0];
  assert.equal(row.deploymentId, deploymentId, 'the mapping is re-derived, not skipped');
  assert.equal(row.resourceVersion, '5', 'and the object itself never moved');
  assert.deepEqual(seenEvents, [{ type: 'update', name: 'ing-a' }]);
});

test('an owner that cannot be resolved is deferred, never guessed at', async () => {
  refsMode = 'owned';
  cluster = [obj('uid-a', 'ing-a', '1')];
  const informer = newInformer();
  await listAndSync(informer);
  assert.equal((await mirrored())[0].deploymentId, deploymentId);

  // The object changes while the lookup is broken. Writing the manifest now
  // would either blank the mapping or, worse, advance the resourceVersion that
  // is the only handle the retry has on it.
  refsMode = 'unresolvable';
  cluster = [obj('uid-a', 'ing-a', '2')];
  await listAndSync(informer);

  let row = (await mirrored())[0];
  assert.equal(row.deploymentId, deploymentId, 'kept the mapping it had');
  assert.equal(row.resourceVersion, '1', 'left behind so the next pass retries');

  refsMode = 'owned';
  await listAndSync(informer);

  row = (await mirrored())[0];
  assert.equal(row.resourceVersion, '2');
  assert.equal(row.deploymentId, deploymentId);
});

test('an object whose handler threw is re-derived on the next pass', async () => {
  cluster = [obj('uid-a', 'ing-a', '5')];
  failHandlerFor = new Set(['ing-a']);
  const informer = newInformer();

  await listAndSync(informer);
  // The manifest landed, but nothing derived from it did, and the row says so.
  assert.deepEqual(seenEvents, []);
  const written = (await mirrored())[0];
  assert.equal(written.derivedVersion, null);

  await listAndSync(informer);

  assert.deepEqual(seenEvents, [{ type: 'update', name: 'ing-a' }]);
  const repaired = (await mirrored())[0];
  assert.equal(repaired.derivedVersion, '5');
  // Only the derivation was missing, so the manifest is left where it is
  // rather than rewritten to say the same thing.
  assert.deepEqual(repaired.syncedAt, written.syncedAt);
});

test('a watch event whose handler threw is re-derived on the next pass', async () => {
  cluster = [obj('uid-a', 'ing-a', '5')];
  const informer = newInformer();
  await listAndSync(informer);
  seenEvents = [];

  cluster = [obj('uid-a', 'ing-a', '6')];
  failHandlerFor = new Set(['ing-a']);
  await handle(informer, 'MODIFIED', obj('uid-a', 'ing-a', '6'));
  // The row now holds a version nothing has been derived from, and says so.
  assert.equal((await mirrored())[0].derivedVersion, null);

  await listAndSync(informer);

  assert.deepEqual(seenEvents, [{ type: 'update', name: 'ing-a' }]);
  assert.equal((await mirrored())[0].derivedVersion, '6');
});

test('deleting and recreating an object under the same name replaces the row', async () => {
  cluster = [obj('uid-old', 'ing-shared', '1')];
  const informer = newInformer();
  await listAndSync(informer);
  assert.equal((await mirrored())[0].uid, 'uid-old');

  // Same natural key, new uid — an upsert keyed only on uid would violate the
  // unique index on (kind, namespace, name, api_version) and, before the fix,
  // abort the list before the stale sweep could clear the displaced row.
  cluster = [obj('uid-new', 'ing-shared', '2')];
  await listAndSync(informer);

  const rows = await mirrored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uid, 'uid-new');
  assert.equal(rows[0].resourceVersion, '2');
});

test('a watch event for a same-name replacement does not collide either', async () => {
  cluster = [obj('uid-old', 'ing-shared', '1')];
  const informer = newInformer();
  await listAndSync(informer);

  await handle(informer, 'ADDED', obj('uid-new', 'ing-shared', '7'));

  const rows = await mirrored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uid, 'uid-new');
});

test('a burst of watch events larger than the concurrency limit still drains', async () => {
  // What a node going down looks like from the pods watch: dozens of objects
  // changing in the same instant. Each event used to hold a semaphore permit
  // for its whole lifetime and then ask for a second one to run the consumer,
  // so once the limit was reached every permit was held by an event waiting on
  // a permit only one of the others could release. The shard stopped applying
  // anything from that moment on and served a frozen cluster until it
  // restarted, which is how deleted pods lived on in the UI for days.
  const informer = newInformer();
  const burst = Array.from({ length: 36 }, (_, i) =>
    obj(`burst-${i}`, `ing-burst-${String(i).padStart(3, '0')}`)
  );

  for (const o of burst) dispatch(informer, 'ADDED', o);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const wedged = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the event pipeline deadlocked')), 20_000);
  });
  try {
    await Promise.race([drain(informer), wedged]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert.equal(seenEvents.length, burst.length);
  assert.equal(await prisma.k8sObject.count({ where: { shard: SHARD } }), burst.length);
});

test('objects that leave the cluster are swept and reported as deletes', async () => {
  cluster = [obj('uid-a', 'ing-a'), obj('uid-b', 'ing-b')];
  const informer = newInformer();
  await listAndSync(informer);
  seenEvents = [];

  cluster = [obj('uid-a', 'ing-a')];
  await listAndSync(informer);

  const rows = await mirrored();
  assert.deepEqual(
    rows.map((r) => r.uid),
    ['uid-a']
  );
  assert.deepEqual(seenEvents, [{ type: 'delete', name: 'ing-b' }]);
});

test('the stale sweep survives an object count past the bind-parameter ceiling', async () => {
  // One parameter per uid would exceed Postgres' 65535-parameter limit here;
  // the sweep binds the whole set as a single array.
  cluster = Array.from({ length: 70_000 }, (_, i) => ({ uid: `u${i}` })).map((x, i) =>
    obj(x.uid, `ing-${i}`)
  );
  const informer = newInformer();
  const seenUids = cluster.map((c) => c.metadata.uid);

  await (
    informer as unknown as { sweepStale(uids: string[], count: boolean): Promise<number> }
  ).sweepStale(seenUids, false);
  // Nothing to assert beyond "it executed" — a parameter-per-uid query throws.
  assert.equal(await prisma.k8sObject.count({ where: { shard: SHARD } }), 0);
});

// --- crash state -------------------------------------------------------------

test('a crashing pod is not announced before the confirm window', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);

  assert.deepEqual(notified, []);
  const state = await prisma.deploymentCrashState.findUnique({ where: { deploymentId } });
  assert.ok(state?.crashingSince);
  assert.equal(state?.notifiedAt, null);
});

test('a crash held past the confirm window is announced exactly once', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);
  await ageCrashState(45_000);

  await consumer.sweepCrashStates();
  await consumer.sweepCrashStates();
  await consumer.reconcileCrashState(deploymentId);

  assert.equal(notified.length, 1);
  assert.equal(notified[0].state, 'crashing');
  assert.equal(notified[0].detail, 'Error (exit code 137)');
});

test('a replacement replica does not re-announce a crash already sent', async () => {
  const first = newConsumer();
  await first.onEvent('add', podEvent('pod-1', true) as never);
  await ageCrashState(45_000);
  await first.sweepCrashStates();
  assert.equal(notified.length, 1);

  // Shard fails over: a brand new consumer with no in-process memory relists
  // and sees the same still-crashing pod.
  notified = [];
  const second = newConsumer();
  await second.onEvent('update', podEvent('pod-1', true) as never);
  await second.sweepCrashStates();

  assert.deepEqual(notified, []);
});

test('recovery is announced once the pod has been healthy for the recovery window', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);
  await ageCrashState(45_000);
  await consumer.sweepCrashStates();
  notified = [];

  await consumer.onEvent('update', podEvent('pod-1', false) as never);
  assert.deepEqual(notified, [], 'recovery is debounced too — a backoff gap is not a recovery');

  await ageCrashState(90_000);
  await consumer.sweepCrashStates();

  assert.equal(notified.length, 1);
  assert.equal(notified[0].state, 'recovered');
  assert.equal(await prisma.deploymentCrashState.count({ where: { deploymentId } }), 0);
});

test('a crash that clears before it was announced is never announced at all', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);
  await consumer.onEvent('update', podEvent('pod-1', false) as never);
  await ageCrashState(90_000);
  await consumer.sweepCrashStates();

  assert.deepEqual(notified, []);
  assert.equal(await prisma.deploymentCrashState.count({ where: { deploymentId } }), 0);
});

test('pods disappearing clears the alert without claiming recovery', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);
  await ageCrashState(45_000);
  await consumer.sweepCrashStates();
  notified = [];

  await consumer.onEvent('delete', podEvent('pod-1', true) as never);
  await ageCrashState(90_000);
  await consumer.sweepCrashStates();

  assert.deepEqual(notified, [], 'a torn-down app did not recover, it went away');
  assert.equal(await prisma.deploymentCrashState.count({ where: { deploymentId } }), 0);
});

test('the prune drops pod rows the cluster no longer lists and clears their alert', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('pod-1', true) as never);
  await ageCrashState(45_000);
  await consumer.sweepCrashStates();
  notified = [];
  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 1);

  // The pod is gone from the cluster and the relist never mentions it.
  await consumer.pruneStalePods([
    { namespace: NS, name: 'something-else', refs: { deploymentId } }
  ]);

  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 0);
  await ageCrashState(90_000);
  await consumer.sweepCrashStates();
  assert.equal(await prisma.deploymentCrashState.count({ where: { deploymentId } }), 0);
});

test('the prune keys on the deployment, not just the pod name', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('web-0', false) as never);
  await consumer.onEvent('add', podEvent('web-0', false, 'test-mirror-dep-b') as never);
  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 1);
  assert.equal(await prisma.pod.count({ where: { deploymentId: otherDeploymentId } }), 1);

  // Only the second deployment still runs a pod called web-0. Matching on the
  // bare name would keep the first deployment's dead row alive forever.
  await consumer.pruneStalePods([
    { namespace: NS, name: 'web-0', refs: { deploymentId: otherDeploymentId } }
  ]);

  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 0);
  assert.equal(await prisma.pod.count({ where: { deploymentId: otherDeploymentId } }), 1);
});

test('a pass that could not resolve every pod prunes nothing', async () => {
  const consumer = newConsumer();
  await consumer.onEvent('add', podEvent('web-0', false) as never);

  // A pod of unknown ownership means the live set is incomplete, and deleting
  // against an incomplete set takes live pods with it.
  await consumer.pruneStalePods([
    { namespace: NS, name: 'someone-elses-pod', refs: null },
    { namespace: NS, name: 'still-running', refs: { deploymentId: otherDeploymentId } }
  ]);

  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 1);
});

test('a pod row lost to a failed sync is restored while the pod sits still', async () => {
  // The whole reported bug, end to end: the pod goes ready, the write of its
  // row fails, and the pod never emits another event for the rest of its life.
  const consumer = newConsumer();
  const pods: any[] = [podEvent('web-0', false)];
  let breakNext = true;
  const informer = new MirrorInformer(
    {} as never,
    prisma as never,
    SHARD,
    {
      kind: 'Pod',
      apiVersion: 'v1',
      watchPath: '/api/v1/pods',
      list: async () => ({ items: pods, resourceVersion: '9000', continueToken: null }),
      mapRefs: (o: any) => consumer.mapRefs(o),
      onEvent: async (type: any, o: any) => {
        if (breakNext) {
          breakNext = false;
          throw new Error('pod row write failed');
        }
        await consumer.onEvent(type, o);
      },
      onListComplete: (seen: any) => consumer.pruneStalePods(seen)
    } as never,
    { onListed: () => {}, onWatchEvent: () => {}, onHealthChange: () => {} }
  );
  (informer as unknown as { stopped: boolean }).stopped = false;

  await listAndSync(informer);
  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 0, 'the write did fail');

  await listAndSync(informer);

  assert.equal(await prisma.pod.count({ where: { deploymentId } }), 1);
  const row = await prisma.pod.findFirst({ where: { deploymentId } });
  assert.equal(row?.name, 'web-0');
  assert.equal(row?.status, computePodStatus(pods[0] as never));
  await prisma.k8sObject.deleteMany({ where: { shard: SHARD } });
});

// --- pod status derivation ---------------------------------------------------

function pod(over: {
  phase?: string;
  ready?: boolean;
  scheduled?: boolean;
  waiting?: string;
  deleting?: boolean;
}) {
  const ready = over.ready ?? false;
  const conditions: any[] = [];
  if (over.scheduled ?? true) conditions.push({ type: 'PodScheduled', status: 'True' });
  conditions.push({ type: 'Ready', status: ready ? 'True' : 'False' });
  return {
    metadata: {
      name: 'p',
      namespace: NS,
      ...(over.deleting ? { deletionTimestamp: new Date().toISOString() } : {})
    },
    status: {
      phase: over.phase ?? 'Running',
      conditions,
      containerStatuses: [
        {
          name: 'app',
          ready,
          restartCount: 0,
          state: over.waiting ? { waiting: { reason: over.waiting } } : { running: {} }
        }
      ]
    }
  } as never;
}

test('a running pod waiting on its health check is starting, not scheduled', () => {
  // The app is up and serving; only readiness has not passed. "Scheduled" told
  // the user about a milestone the pod cleared long ago.
  assert.equal(computePodStatus(pod({ phase: 'Running', ready: false })), 'starting');
  assert.equal(computePodStatus(pod({ phase: 'Running', ready: true })), 'ready');
});

test('scheduled still means assigned to a node with nothing running yet', () => {
  assert.equal(computePodStatus(pod({ phase: 'Pending', scheduled: true })), 'scheduled');
  assert.equal(computePodStatus(pod({ phase: 'Pending', scheduled: false })), 'pending');
});

test('every stuck waiting reason reads as crashing, not as progress', () => {
  for (const reason of [
    'CrashLoopBackOff',
    'ImagePullBackOff',
    'ErrImagePull',
    'ErrImagePullBackOff',
    'CreateContainerError',
    'CreateContainerConfigError',
    'RunContainerError',
    'InvalidImageName'
  ]) {
    assert.equal(
      computePodStatus(pod({ phase: 'Pending', waiting: reason })),
      'crashing',
      `${reason} should read as crashing`
    );
  }
});

test('a pod being deleted is terminating, even mid crash loop', () => {
  assert.equal(
    computePodStatus(pod({ phase: 'Running', ready: true, deleting: true })),
    'terminating'
  );
  assert.equal(
    computePodStatus(pod({ phase: 'Running', waiting: 'CrashLoopBackOff', deleting: true })),
    'terminating'
  );
});
