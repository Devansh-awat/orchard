import test from 'node:test';
import assert from 'node:assert/strict';
import { dbStatsFromMetrics } from '../src/kubernetes/db-stats';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';

const primary = { namespace: 'ns-a', pod: 'pg-a-1', dbName: 'app' };

test('a primary missing size or WAL backlog is left for the exec fallback', () => {
  const noWal = dbStatsFromMetrics([primary], {
    size: [{ metric: { namespace: 'ns-a', pod: 'pg-a-1', datname: 'app' }, value: 1 }],
    connections: [],
    walPending: []
  });
  assert.equal(noWal.size, 0);
  const noSize = dbStatsFromMetrics([primary], {
    size: [],
    connections: [],
    walPending: [{ metric: { namespace: 'ns-a', pod: 'pg-a-1' }, value: 0 }]
  });
  assert.equal(noSize.size, 0);
});

function consumer(row: any) {
  const updates: any[] = [];
  let execs = 0;
  const svc = Object.create(CnpgConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    lastSample: new Map(),
    sampling: new Set(),
    storageState: new Map(),
    prisma: {
      database: {
        findUnique: async () => row,
        update: async (args: any) => {
          updates.push(args.data);
          Object.assign(row, args.data);
          return {};
        }
      }
    },
    cnpg: {
      sampleDatabaseStats: async () => {
        execs += 1;
        return null;
      }
    },
    notifications: { notifyDbStorage: async () => {} },
    scheduleEmit: () => {}
  });
  return { svc, updates, execs: () => execs };
}

const ctx = { databaseId: 'db-1', orgId: 'o', projectId: 'p' };
const fromMetrics = {
  sizeBytes: 2048,
  connections: 2,
  walPendingSegments: 0,
  volumeCapacityBytes: null,
  volumeUsedBytes: null
};

test('a metrics sample skips the exec and keeps the swept volume', async () => {
  const row = { dbName: 'app', volumeUsedBytes: 500n, volumeCapacityBytes: 1000n };
  const { svc, updates, execs } = consumer(row);
  svc.lastDataDirMeasure = new Map([['db-1', Date.now()]]);
  await svc.sampleStats(ctx, 'pg-1', 'ns', fromMetrics);
  assert.equal(execs(), 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sizeBytes, 2048n);
  assert.equal(updates[0].volumeUsedBytes, 500n);
  assert.equal(updates[0].volumeCapacityBytes, 1000n);
});

test('every five minutes a metrics sample also execs once to measure the disk, and still records the metrics if that fails', async () => {
  const row = { dbName: 'app', volumeUsedBytes: 500n, volumeCapacityBytes: 1000n };
  const { svc, updates, execs } = consumer(row);
  svc.lastDataDirMeasure = new Map([['db-1', Date.now() - 6 * 60 * 1000]]);
  await svc.sampleStats(ctx, 'pg-1', 'ns', fromMetrics);
  assert.equal(execs(), 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sizeBytes, 2048n);
  assert.equal(updates[0].volumeUsedBytes, 500n);
});

test('node disk pressure seen by the exec holds through the metrics-only samples after it', async () => {
  const notes: string[] = [];
  const row: any = {
    dbName: 'app',
    storageSize: '10Gi',
    volumeUsedBytes: null,
    volumeCapacityBytes: null
  };
  const svc = Object.create(CnpgConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    lastSample: new Map(),
    sampling: new Set(),
    storageState: new Map(),
    prisma: {
      database: {
        findUnique: async () => row,
        update: async (args: any) => Object.assign(row, args.data)
      }
    },
    cnpg: {
      sampleDatabaseStats: async () => ({
        sizeBytes: 1,
        connections: 1,
        walPendingSegments: 0,
        volumeUsedBytes: 95,
        volumeCapacityBytes: 100,
        shared: { dataDirBytes: 1024 ** 3 }
      })
    },
    notifications: { notifyDbStorage: async (_id: string, kind: string) => notes.push(kind) },
    scheduleEmit: () => {}
  });
  await svc.sampleStats(ctx, 'pg-1', 'ns');
  for (let i = 0; i < 3; i += 1) {
    svc.lastSample.clear();
    await svc.sampleStats(ctx, 'pg-1', 'ns', fromMetrics);
  }
  assert.deepEqual(notes, ['pressure']);
});

test('without a metrics store the sampler never queries one, and after a failure it backs off', async () => {
  const prev = process.env.VICTORIAMETRICS_URL;
  let queries = 0;
  let failing = true;
  const svc = Object.create(CnpgConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    statsFallbackWarnedAt: 0,
    metricsBackoffUntil: 0,
    vm: {
      queryInstantVector: async () => {
        queries += 1;
        if (failing) throw new Error('getaddrinfo ENOTFOUND victoriametrics');
        return [];
      }
    }
  });
  const primaries = [{ namespace: 'ns', pod: 'pg-1', dbName: 'app' }];
  try {
    delete process.env.VICTORIAMETRICS_URL;
    assert.equal((await svc.statsFromMetrics(primaries)).size, 0);
    assert.equal(queries, 0);

    process.env.VICTORIAMETRICS_URL = 'http://vm:8428';
    await svc.statsFromMetrics(primaries);
    const afterFailure = queries;
    assert.ok(afterFailure > 0);
    failing = false;
    await svc.statsFromMetrics(primaries);
    await svc.statsFromMetrics(primaries);
    assert.equal(queries, afterFailure);

    svc.metricsBackoffUntil = Date.now() - 1;
    await svc.statsFromMetrics(primaries);
    assert.ok(queries > afterFailure);
  } finally {
    if (prev === undefined) delete process.env.VICTORIAMETRICS_URL;
    else process.env.VICTORIAMETRICS_URL = prev;
  }
});
