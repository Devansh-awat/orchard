import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backupTransition,
  BACKUP_TIMEOUT_MS,
  WAL_ARCHIVING_FAILING_MESSAGE,
  WAL_ARCHIVING_GRACE_MS,
  supersededBackups
} from '../src/projects/backup-transition';

const MINUTE = 60 * 1000;
const now = Date.parse('2026-10-07T21:00:00Z');
const row = (status: string, ageMs: number) => ({ status, createdAt: new Date(now - ageMs) });
const live = (phase: string, error?: string) => ({ status: { phase, error } });

test('a backup whose cluster cannot archive wal fails once the grace period is over', () => {
  assert.equal(
    backupTransition(
      row('running', WAL_ARCHIVING_GRACE_MS - MINUTE),
      live('walArchivingFailing'),
      now
    ),
    null
  );
  assert.deepEqual(
    backupTransition(
      row('running', WAL_ARCHIVING_GRACE_MS + MINUTE),
      live('walArchivingFailing'),
      now
    ),
    { status: 'failed', errorMessage: WAL_ARCHIVING_FAILING_MESSAGE }
  );
  assert.deepEqual(
    backupTransition(
      row('pending', 2 * WAL_ARCHIVING_GRACE_MS),
      live('walArchivingFailing', 'Expected empty archive'),
      now
    ),
    { status: 'failed', errorMessage: `${WAL_ARCHIVING_FAILING_MESSAGE}: Expected empty archive` }
  );
});

test('terminal phases, missing resources and timeouts map as before', () => {
  assert.deepEqual(backupTransition(row('running', MINUTE), live('completed'), now), {
    status: 'completed',
    errorMessage: null
  });
  assert.deepEqual(backupTransition(row('running', MINUTE), live('failed', 'exit status 1'), now), {
    status: 'failed',
    errorMessage: 'exit status 1'
  });
  assert.deepEqual(backupTransition(row('pending', MINUTE), live('started'), now), {
    status: 'running',
    errorMessage: null
  });
  assert.equal(backupTransition(row('running', MINUTE), live('running'), now), null);
  assert.equal(backupTransition(row('pending', MINUTE), null, now), null);
  assert.deepEqual(backupTransition(row('pending', 11 * MINUTE), null, now), {
    status: 'failed',
    errorMessage: 'Backup resource not found in cluster'
  });
  assert.deepEqual(
    backupTransition(row('running', BACKUP_TIMEOUT_MS + MINUTE), live('running'), now),
    { status: 'failed', errorMessage: 'Backup timed out' }
  );
});

test('older scheduled backups still waiting behind a newer one are superseded, running and manual ones are kept', () => {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString();
  const scheduled = (name: string, minutesAgo: number, phase?: string) => ({
    metadata: {
      name,
      creationTimestamp: at(minutesAgo),
      labels: { 'cnpg.io/scheduled-backup': 'sched' }
    },
    status: phase === undefined ? undefined : { phase }
  });
  const items = [
    scheduled('s-old-pending', 180, 'pending'),
    scheduled('s-old-nophase', 120),
    scheduled('s-old-archiving', 90, 'walArchivingFailing'),
    scheduled('s-running', 60, 'running'),
    scheduled('s-young', 10, 'pending'),
    scheduled('s-newest', 5, 'pending'),
    scheduled('s-done', 240, 'completed'),
    {
      metadata: { name: 'manual', creationTimestamp: at(300) },
      status: { phase: 'pending' }
    }
  ];
  assert.deepEqual(supersededBackups(items, now).sort(), [
    's-old-archiving',
    's-old-nophase',
    's-old-pending'
  ]);
  assert.deepEqual(supersededBackups([scheduled('only', 500, 'pending')], now), []);
});
