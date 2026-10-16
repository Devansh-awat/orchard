import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCnpgLiveStatus,
  clusterSnapshot,
  foldPods,
  formatDbSize,
  type MirroredDbPod
} from '../src/kubernetes/cnpg-status';
import { CnpgMirrorConsumer } from '../src/mirror/consumers/cnpg-mirror.consumer';

const NOW = Date.parse('2026-09-28T12:00:00Z');

function pod(over: Partial<MirroredDbPod> = {}): MirroredDbPod {
  return {
    status: 'ready',
    restartCount: 0,
    ready: true,
    lastTerminationReason: null,
    lastExitCode: null,
    lastTerminatedAt: null,
    updatedAt: new Date(NOW - 60_000),
    ...over
  };
}

const cluster = clusterSnapshot({
  spec: { instances: 1 },
  status: {
    phase: 'Cluster in healthy state',
    instances: 1,
    readyInstances: 1,
    currentPrimary: 'db-1',
    conditions: [{ type: 'ContinuousArchiving', status: 'True', lastTransitionTime: 'x' }]
  }
});

test('size and connections come from the sampled columns, never from the readiness gate', () => {
  const s = buildCnpgLiveStatus(
    { ...cluster, readyInstances: 0 },
    [pod({ ready: false, status: 'pending' })],
    { sizeBytes: 1024n * 1024n * 37n, connections: 4, statsAt: new Date(NOW - 50_000) },
    NOW
  );
  assert.equal(s.ready, false);
  assert.equal(s.size, '37 MB');
  assert.equal(s.connections, 4);
  assert.equal(s.statsAt, new Date(NOW - 50_000).toISOString());
});

test('volume usage and the archive backlog ride along with the sampled columns', () => {
  const GiB = 1024 * 1024 * 1024;
  const s = buildCnpgLiveStatus(
    cluster,
    [pod()],
    {
      sizeBytes: 3 * GiB,
      connections: 1,
      statsAt: new Date(NOW),
      volumeUsedBytes: BigInt(11 * GiB),
      volumeCapacityBytes: BigInt(20 * GiB),
      walPendingSegments: 418
    },
    NOW
  );
  assert.deepEqual(s.volume, {
    usedBytes: 11 * GiB,
    capacityBytes: 20 * GiB,
    used: '11 GB',
    capacity: '20 GB',
    percent: 55
  });
  assert.equal(s.walPendingSegments, 418);
  const bare = buildCnpgLiveStatus(
    cluster,
    [pod()],
    { sizeBytes: 1, connections: 0, statsAt: null },
    NOW
  );
  assert.equal(bare.volume, null);
  assert.equal(bare.walPendingSegments, undefined);
});

test('a fresh OOM is surfaced, a stale one after ten clean minutes is not', () => {
  const fresh = foldPods(
    [pod({ lastTerminationReason: 'OOMKilled', lastExitCode: 137, restartCount: 3 })],
    NOW
  );
  assert.equal(fresh.message, 'OOMKilled');
  assert.equal(fresh.restartCount, 3);
  const stale = foldPods(
    [
      pod({
        lastTerminationReason: 'OOMKilled',
        updatedAt: new Date(NOW - 11 * 60_000),
        runningSince: new Date(NOW - 11 * 60_000)
      })
    ],
    NOW
  );
  assert.equal(stale.message, undefined);
  assert.equal(
    foldPods([pod({ status: 'crashing', ready: false })], NOW).message,
    'CrashLoopBackOff'
  );
});

test('a mirrored row with no running time goes stale from its last termination, not its last rewrite', () => {
  const daysOld = foldPods(
    [
      pod({
        lastTerminationReason: 'Error',
        lastExitCode: 4,
        lastTerminatedAt: new Date(NOW - 5 * 24 * 60 * 60_000),
        updatedAt: new Date(NOW - 30_000)
      })
    ],
    NOW
  );
  assert.equal(daysOld.message, undefined);
  assert.equal(daysOld.lastTerminationReason, 'Error');
  const justNow = foldPods(
    [
      pod({
        lastTerminationReason: 'Error',
        lastTerminatedAt: new Date(NOW - 2 * 60_000),
        updatedAt: new Date(NOW - 30_000)
      })
    ],
    NOW
  );
  assert.equal(justNow.message, 'Error');
});

test('a hibernated cluster reads as stopped and a deleted one as absent', () => {
  assert.equal(
    buildCnpgLiveStatus({ ...cluster, hibernated: true }, [pod()], {
      sizeBytes: null,
      connections: null,
      statsAt: null
    }).phase,
    'hibernated'
  );
  assert.deepEqual(
    buildCnpgLiveStatus({ ...cluster, exists: false }, [], {
      sizeBytes: null,
      connections: null,
      statsAt: null
    }),
    { exists: false }
  );
});

test('sizes format the way pg_size_pretty did, with a decimal from GB up', () => {
  assert.equal(formatDbSize(0), '0 bytes');
  assert.equal(formatDbSize(900), '900 bytes');
  assert.equal(formatDbSize(8 * 1024), '8 kB');
  assert.equal(formatDbSize(1024 * 1024 * 1024 * 3), '3 GB');
  assert.equal(formatDbSize(29479792640), '27.5 GB');
  assert.equal(formatDbSize(24128050879), '22.5 GB');
  assert.equal(formatDbSize(null), undefined);
});

test('the sampler writes the columns, emits once, and never runs twice inside the gap', async () => {
  const updates: any[] = [];
  const emits: unknown[] = [];
  const notified: unknown[] = [];
  let execs = 0;
  let sample: any = {
    sizeBytes: 2048,
    connections: 7,
    volumeUsedBytes: 900,
    volumeCapacityBytes: 1000,
    walPendingSegments: 3
  };
  const svc = Object.create(CnpgMirrorConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    lastSample: new Map(),
    sampling: new Set(),
    storageState: new Map(),
    prisma: {
      database: {
        findUnique: async () => ({ dbName: 'app' }),
        update: async (args: any) => {
          updates.push(args.data);
          return {};
        }
      }
    },
    cnpg: {
      sampleDatabaseStats: async () => {
        execs += 1;
        return sample;
      }
    },
    notifications: {
      notifyDbStorage: async (...args: unknown[]) => {
        notified.push(args);
      }
    },
    scheduleEmit: (_ctx: unknown, payload: unknown) => emits.push(payload)
  });
  const ctx = { databaseId: 'db-1', orgId: 'o', projectId: 'p' };
  await svc.sampleStats(ctx, 'db-1-1', 'ns');
  await svc.sampleStats(ctx, 'db-1-1', 'ns');
  assert.equal(execs, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sizeBytes, 2048n);
  assert.equal(updates[0].connections, 7);
  assert.equal(updates[0].volumeUsedBytes, 900n);
  assert.equal(updates[0].volumeCapacityBytes, 1000n);
  assert.equal(updates[0].walPendingSegments, 3);
  assert.ok(updates[0].statsAt instanceof Date);
  assert.deepEqual(emits, [{ stats: true }]);
  assert.deepEqual(notified, [['db-1', 'pressure', 'the volume is 90% full']]);

  svc.lastSample.clear();
  sample = { ...sample, volumeUsedBytes: 800 };
  await svc.sampleStats(ctx, 'db-1-1', 'ns');
  assert.equal(notified.length, 1);

  svc.lastSample.clear();
  sample = { ...sample, volumeUsedBytes: 500 };
  await svc.sampleStats(ctx, 'db-1-1', 'ns');
  assert.deepEqual(notified[1], ['db-1', 'recovered', undefined]);

  svc.lastSample.clear();
  sample = { ...sample, volumeUsedBytes: null, volumeCapacityBytes: null };
  await svc.sampleStats(ctx, 'db-1-1', 'ns');
  assert.equal(updates.at(-1).volumeUsedBytes, null);
  assert.equal(notified.length, 2);
});

test('a pod event writes the row with its primary flag and only reconciles crash state on a status change', async () => {
  const upserts: any[] = [];
  let reconciled = 0;
  const captured: unknown[] = [];
  let existingStatus: string | null = null;
  const svc = Object.create(CnpgMirrorConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    ctxCache: new Map(),
    lastEmit: new Map(),
    pending: new Map(),
    lastSample: new Map(),
    sampling: new Set(),
    prisma: {
      database: {
        findFirst: async () => ({ id: 'db-1', projectId: 'p', project: { organizationId: 'o' } }),
        findUnique: async () => ({ dbName: 'app' }),
        update: async () => ({})
      },
      databasePod: {
        findUnique: async () => (existingStatus ? { status: existingStatus } : null),
        upsert: async (args: any) => {
          upserts.push(args);
          return {};
        }
      }
    },
    reconcileCrashState: async () => {
      reconciled += 1;
    },
    logCapture: { capture: async (...a: unknown[]) => captured.push(a) },
    cnpg: { sampleDatabaseStats: async () => ({ sizeBytes: 1, connections: 0 }) },
    scheduleEmit: () => {}
  });
  const pod = {
    metadata: {
      name: 'db-1-1',
      namespace: 'ns',
      labels: { 'cnpg.io/cluster': 'db-1', 'cnpg.io/instanceRole': 'primary' }
    },
    spec: { nodeName: 'n1' },
    status: {
      phase: 'Running',
      podIP: '10.0.0.1',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        { name: 'postgres', ready: true, restartCount: 2, state: { running: {} } }
      ]
    }
  };
  await svc.onPodEvent('add', pod);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.currentPrimary, true);
  assert.equal(upserts[0].create.restartCount, 2);
  assert.equal(reconciled, 1);
  assert.equal(captured.length, 1);
  assert.equal((captured[0] as unknown[])[3], 'database');

  existingStatus = upserts[0].create.status;
  await svc.onPodEvent('update', pod);
  assert.equal(upserts.length, 2);
  assert.equal(reconciled, 1);
});

test('a paused cluster says what size resumes writes, an unpaused one does not', () => {
  const GiB = 1024 * 1024 * 1024;
  const stats = {
    sizeBytes: 26 * GiB,
    connections: 1,
    statsAt: new Date(NOW),
    volumeUsedBytes: 27_905_277_952n,
    volumeCapacityBytes: 31_593_590_784n
  };
  const paused = clusterSnapshot({
    metadata: { annotations: { 'orchard.io/write-guard': 'storage' } },
    spec: { instances: 1, storage: { size: '30Gi' } },
    status: { phase: 'Cluster in healthy state', instances: 1, readyInstances: 1 }
  });
  assert.equal(buildCnpgLiveStatus(paused, [pod()], stats, NOW).resumeWritesAt, '32Gi');
  assert.equal(
    buildCnpgLiveStatus({ ...paused, writeGuard: false }, [pod()], stats, NOW).resumeWritesAt,
    null
  );
  assert.equal(
    buildCnpgLiveStatus({ ...paused, storageSize: undefined }, [pod()], stats, NOW).resumeWritesAt,
    null
  );
});
