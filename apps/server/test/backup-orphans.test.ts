import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmedOrphans,
  ORPHAN_CONFIRM_MS,
  orphanCandidates,
  orphanKey
} from '../src/projects/backup-transition';

const now = Date.parse('2026-10-30T12:00:00Z');
const old = '2026-10-14T03:00:00Z';

const cluster = (namespace: string, name: string) => ({ metadata: { namespace, name } });
const ref = (namespace: string, name: string, clusterName: string, phase?: string, at = old) => ({
  metadata: { namespace, name, creationTimestamp: at },
  spec: { cluster: { name: clusterName } },
  status: phase ? { phase } : null
});

test('schedules and unfinished backups of a vanished cluster are candidates', () => {
  const candidates = orphanCandidates(
    [cluster('ysws-haven', 'pg-booking-db-restored')],
    [
      ref('ysws-haven', 'b-waiting', 'pg-booking-db'),
      ref('ysws-pixl', 'b-running', 'pg-pixl-primary', 'running'),
      ref('ysws-haven', 'b-done', 'pg-booking-db', 'completed'),
      ref('ysws-haven', 'b-failed', 'pg-booking-db', 'failed'),
      ref('ysws-haven', 'b-live', 'pg-booking-db-restored')
    ],
    [
      ref('ysws-haven', 'pg-booking-db-schedule', 'pg-booking-db'),
      ref('ysws-haven', 'pg-booking-db-restored-schedule', 'pg-booking-db-restored')
    ],
    now
  );
  assert.deepEqual(candidates.map(orphanKey).sort(), [
    'backup:ysws-haven/b-waiting',
    'backup:ysws-pixl/b-running',
    'schedule:ysws-haven/pg-booking-db-schedule'
  ]);
});

test('a cluster in another namespace with the same name does not shield an orphan', () => {
  const candidates = orphanCandidates(
    [cluster('other', 'pg-db')],
    [],
    [ref('mine', 'pg-db-schedule', 'pg-db')],
    now
  );
  assert.equal(candidates.length, 1);
});

test('objects younger than the grace window are left alone', () => {
  const fresh = new Date(now - 60_000).toISOString();
  assert.equal(orphanCandidates([], [ref('ns', 'b', 'pg', undefined, fresh)], [], now).length, 0);
});

test('an orphan is only confirmed after two 404s at least 90s apart', () => {
  const c = { kind: 'schedule' as const, namespace: 'ns', name: 's', cluster: 'pg' };
  const missing = new Set([orphanKey(c)]);
  const seen = new Map<string, number>();
  assert.deepEqual(confirmedOrphans([c], missing, seen, now), []);
  assert.deepEqual(confirmedOrphans([c], missing, seen, now + 30_000), []);
  assert.deepEqual(confirmedOrphans([c], missing, seen, now + ORPHAN_CONFIRM_MS), [c]);
});

test('an unknown answer resets the confirmation instead of counting as gone', () => {
  const c = { kind: 'backup' as const, namespace: 'ns', name: 'b', cluster: 'pg' };
  const seen = new Map<string, number>();
  confirmedOrphans([c], new Set([orphanKey(c)]), seen, now);
  confirmedOrphans([c], new Set(), seen, now + ORPHAN_CONFIRM_MS);
  assert.equal(seen.size, 0);
  assert.deepEqual(
    confirmedOrphans([c], new Set([orphanKey(c)]), seen, now + 2 * ORPHAN_CONFIRM_MS),
    []
  );
});
