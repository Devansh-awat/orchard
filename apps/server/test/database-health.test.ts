import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseHealth, type DatabaseHealthInput } from '../src/databases/database-health';

const NOW = Date.UTC(2026, 9, 28, 12, 0);
const GIB = 1024 ** 3;
const base: DatabaseHealthInput = {
  status: 'ready',
  hibernated: false,
  instances: 1,
  readyInstances: 1,
  lastSuccessfulBackup: new Date(NOW - 3_600_000).toISOString(),
  backupsOff: false,
  volumeUsedBytes: 2 * GIB,
  volumeCapacityBytes: 10 * GIB,
  walPendingSegments: 0,
  connections: 10,
  maxConnections: 100,
  replicationLagSeconds: null,
  now: NOW
};

test('a healthy database has no lines', () => {
  assert.deepEqual(databaseHealth(base), { status: 'healthy', lines: [] });
});

test('never backed up is an error', () => {
  const h = databaseHealth({ ...base, lastSuccessfulBackup: null });
  assert.equal(h.status, 'error');
  assert.deepEqual(h.lines, [{ tone: 'error', text: 'Never backed up' }]);
});

test('an old backup warns after 26 hours and reads in days later', () => {
  assert.deepEqual(
    databaseHealth({ ...base, lastSuccessfulBackup: new Date(NOW - 27 * 3_600_000).toISOString() })
      .lines,
    [{ tone: 'warning', text: 'Last backup 27 hours ago' }]
  );
  assert.equal(
    databaseHealth({ ...base, lastSuccessfulBackup: new Date(NOW - 3 * 86_400_000).toISOString() })
      .lines[0].text,
    'Last backup 3 days ago'
  );
});

test('disk, wal, replica and connection pressure each get a line, errors first', () => {
  const h = databaseHealth({
    ...base,
    volumeUsedBytes: 9.3 * GIB,
    walPendingSegments: 64,
    replicationLagSeconds: 12,
    connections: 92,
    instances: 2,
    readyInstances: 1
  });
  assert.equal(h.status, 'error');
  assert.deepEqual(
    h.lines.map((l) => l.text),
    [
      'Disk 93% full',
      '1 of 2 instances ready',
      'WAL archiving is behind (64 files waiting)',
      'Replica 12s behind',
      'Connections 92 of 100'
    ]
  );
});

test('disk under 85 percent is quiet and 87 percent warns', () => {
  assert.equal(databaseHealth({ ...base, volumeUsedBytes: 8 * GIB }).lines.length, 0);
  assert.deepEqual(databaseHealth({ ...base, volumeUsedBytes: 8.7 * GIB }).lines, [
    { tone: 'warning', text: 'Disk 87% full' }
  ]);
});

test('stopped databases say so and nothing else', () => {
  assert.deepEqual(databaseHealth({ ...base, hibernated: true, lastSuccessfulBackup: null }), {
    status: 'stopped',
    lines: [{ tone: 'neutral', text: 'Stopped' }]
  });
});

test('backups off is a warning, not never backed up', () => {
  assert.deepEqual(
    databaseHealth({ ...base, backupsOff: true, lastSuccessfulBackup: null }).lines,
    [{ tone: 'warning', text: 'Backups are off' }]
  );
});
