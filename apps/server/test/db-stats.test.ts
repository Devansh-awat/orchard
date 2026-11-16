import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbStatsCommand,
  nodeDiskPressure,
  parseDbStatsOutput,
  storagePressure,
  storagePressureDetail
} from '../src/kubernetes/db-stats';

test('the sample command is one shell round trip that survives df going missing', () => {
  const [sh, flag, script] = dbStatsCommand('app');
  assert.equal(sh, 'sh');
  assert.equal(flag, '-c');
  assert.match(script, /pg_database_size\('app'\)/);
  assert.match(script, /pg_ls_archive_statusdir\(\)/);
  assert.match(script, /df -B1 --output=size,used \/var\/lib\/postgresql\/data 2>\/dev\/null/);
});

test('psql and df lines are parsed together, and each degrades on its own', () => {
  assert.deepEqual(parseDbStatsOutput('3006477312|4|418\n    21003583488 11811160064\n'), {
    sizeBytes: 3006477312,
    connections: 4,
    walPendingSegments: 418,
    volumeCapacityBytes: 21003583488,
    volumeUsedBytes: 11811160064
  });
  assert.deepEqual(parseDbStatsOutput('2048|7|0\n'), {
    sizeBytes: 2048,
    connections: 7,
    walPendingSegments: 0,
    volumeCapacityBytes: null,
    volumeUsedBytes: null
  });
  assert.deepEqual(parseDbStatsOutput('2048|7\n'), {
    sizeBytes: 2048,
    connections: 7,
    walPendingSegments: null,
    volumeCapacityBytes: null,
    volumeUsedBytes: null
  });
  assert.equal(parseDbStatsOutput(''), null);
  assert.equal(parseDbStatsOutput('psql: error: connection refused\n  100 50\n'), null);
});

test('pressure enters at 85% or a 1GiB archive backlog and only clears well below both', () => {
  const at = (pct: number, pending = 0) => ({
    volumeUsedBytes: pct * 10,
    volumeCapacityBytes: 1000,
    walPendingSegments: pending
  });
  assert.equal(storagePressure(undefined, at(84)), false);
  assert.equal(storagePressure(undefined, at(85)), true);
  assert.equal(storagePressure(undefined, at(10, 64)), true);
  assert.equal(storagePressure(undefined, at(10, 63)), false);
  assert.equal(storagePressure(true, at(80)), true);
  assert.equal(storagePressure(true, at(74)), false);
  assert.equal(storagePressure(true, at(50, 16)), true);
  assert.equal(storagePressure(true, at(50, 15)), false);
  assert.equal(storagePressure(false, at(80)), false);
  assert.equal(
    storagePressure(true, {
      volumeUsedBytes: null,
      volumeCapacityBytes: null,
      walPendingSegments: 0
    }),
    false
  );
});

test('the detail names whichever side is under pressure', () => {
  assert.equal(
    storagePressureDetail({
      volumeUsedBytes: 900,
      volumeCapacityBytes: 1000,
      walPendingSegments: 0
    }),
    'the volume is 90% full'
  );
  assert.equal(
    storagePressureDetail({
      volumeUsedBytes: 100,
      volumeCapacityBytes: 1000,
      walPendingSegments: 418
    }),
    '418 WAL segments (6.5 GiB) are waiting to be archived'
  );
  assert.equal(
    storagePressureDetail({
      volumeUsedBytes: 900,
      volumeCapacityBytes: 1000,
      walPendingSegments: 64
    }),
    'the volume is 90% full and 64 WAL segments (1.0 GiB) are waiting to be archived'
  );
});

test('a data dir on the node disk is measured with du, and a full node disk alone is pressure', () => {
  assert.deepEqual(
    parseDbStatsOutput('2048|1|0\n196318593024 98864812032\nshared 663314378\n')?.shared,
    {
      dataDirBytes: 663314378
    }
  );
  assert.equal(parseDbStatsOutput('2048|1|0\n21003583488 11811160064\n')?.shared, undefined);
  const nodeFull = {
    volumeUsedBytes: 600,
    volumeCapacityBytes: 3000,
    nodeDiskUsedBytes: 90,
    nodeDiskCapacityBytes: 100,
    walPendingSegments: 0
  };
  assert.equal(storagePressure(undefined, nodeFull), true);
  assert.equal(nodeDiskPressure(nodeFull), true);
  assert.equal(storagePressureDetail(nodeFull), 'the node disk it shares is 90% full');
  const ownFull = { ...nodeFull, volumeUsedBytes: 2700, nodeDiskUsedBytes: 50 };
  assert.equal(storagePressure(undefined, ownFull), true);
  assert.equal(nodeDiskPressure(ownFull), false);
  assert.equal(storagePressure(undefined, { ...nodeFull, nodeDiskUsedBytes: 50 }), false);
});

test('the data dir is measured at low priority with a timeout, and skipped when asked', () => {
  const measured = dbStatsCommand('app')[2];
  assert.match(measured, /timeout 30 nice -n 19 du -sxb \/var\/lib\/postgresql\/data/);
  const skipped = dbStatsCommand('app', { measureDataDir: false })[2];
  assert.doesNotMatch(skipped, /du -sxb/);
  assert.match(skipped, /echo "shared "/);
  assert.deepEqual(parseDbStatsOutput('2048|1|0\n196318593024 98864812032\nshared\n')?.shared, {
    dataDirBytes: null
  });
});
