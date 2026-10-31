import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseVerdict, type DbVerdictInput } from '../src/kubernetes/cnpg-health';

const now = Date.parse('2026-10-30T19:30:00Z');
const base: DbVerdictInput = {
  hibernated: false,
  instances: 1,
  readyInstances: 1,
  archiving: { ok: true },
  firstRecoverabilityPoint: '2026-10-01T00:00:00Z',
  lastSuccessfulBackup: '2026-10-30T02:00:00Z'
};

test('a ready, archiving, recently backed up database is healthy', () => {
  assert.deepEqual(databaseVerdict(base, now), { verdict: 'healthy', reasons: [] });
});

test('a database restarting from OOM kills is degraded even while it reads ready', () => {
  const v = databaseVerdict({ ...base, message: 'OOMKilled' }, now);
  assert.equal(v.verdict, 'degraded');
  assert.deepEqual(v.reasons, ['Last restart: OOMKilled']);
});

test('no backup configuration is unprotected, not healthy', () => {
  const v = databaseVerdict(
    {
      ...base,
      instances: 3,
      readyInstances: 3,
      archiving: null,
      firstRecoverabilityPoint: null,
      lastSuccessfulBackup: null
    },
    now
  );
  assert.equal(v.verdict, 'unprotected');
  assert.deepEqual(v.reasons, ['No backups configured', 'No base backup to restore from']);
});

test('stale backups are unprotected', () => {
  const v = databaseVerdict({ ...base, lastSuccessfulBackup: '2026-10-24T02:00:00Z' }, now);
  assert.equal(v.verdict, 'unprotected');
});

test('down outranks everything and keeps the other reasons', () => {
  const v = databaseVerdict({ ...base, readyInstances: 0, archiving: { ok: false } }, now);
  assert.equal(v.verdict, 'down');
  assert.deepEqual(v.reasons, ['No instance is ready', 'WAL archiving is failing']);
});

test('disk pressure and WAL backlog degrade', () => {
  assert.equal(databaseVerdict({ ...base, volumeFraction: 0.9 }, now).verdict, 'degraded');
  assert.equal(databaseVerdict({ ...base, walPendingSegments: 70 }, now).verdict, 'degraded');
  assert.equal(databaseVerdict({ ...base, writeGuard: true }, now).verdict, 'degraded');
});

test('a stopped database is hibernated', () => {
  assert.equal(databaseVerdict({ ...base, hibernated: true }, now).verdict, 'hibernated');
});
