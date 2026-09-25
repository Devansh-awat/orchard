import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseStatus,
  deploymentStatus,
  incidentsFromTransitions,
  normalizeComponents,
  overallStatus,
  uptimeDays,
  uptimePercent
} from '../src/status-pages/status-model';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const healthy = {
  status: 'running',
  stopped: false,
  replicas: 2,
  workload: { specReplicas: 2, readyReplicas: 2 },
  crashingSince: null,
  firingAlerts: 0
};

test('an app is operational only when every replica the cluster wants is ready', () => {
  assert.equal(deploymentStatus(healthy).status, 'operational');
  assert.deepEqual(
    deploymentStatus({ ...healthy, workload: { specReplicas: 2, readyReplicas: 1 } }),
    {
      status: 'degraded',
      detail: '1 of 2 replicas ready'
    }
  );
  assert.equal(
    deploymentStatus({ ...healthy, workload: { specReplicas: 2, readyReplicas: 0 } }).status,
    'down'
  );
});

test('the crash state outranks the replica counts, and a stopped app is maintenance, not an outage', () => {
  assert.equal(deploymentStatus({ ...healthy, crashingSince: ago(3) }).status, 'degraded');
  assert.equal(
    deploymentStatus({
      ...healthy,
      crashingSince: ago(3),
      workload: { specReplicas: 2, readyReplicas: 0 }
    }).status,
    'down'
  );
  assert.equal(deploymentStatus({ ...healthy, stopped: true }).status, 'maintenance');
  assert.equal(deploymentStatus({ ...healthy, status: 'stopped' }).status, 'maintenance');
});

test('a firing alert degrades an app that is otherwise serving, and no cluster data is unknown, never green', () => {
  assert.deepEqual(deploymentStatus({ ...healthy, firingAlerts: 1 }), {
    status: 'degraded',
    detail: 'An alert is firing'
  });
  assert.equal(deploymentStatus({ ...healthy, workload: null }).status, 'unknown');
});

test('a database reads from its lifecycle status and its own crash state', () => {
  assert.equal(databaseStatus({ status: 'ready', crashingSince: null }).status, 'operational');
  assert.equal(databaseStatus({ status: 'restoring', crashingSince: null }).status, 'degraded');
  assert.equal(databaseStatus({ status: 'error', crashingSince: null }).status, 'down');
  assert.equal(databaseStatus({ status: 'ready', crashingSince: ago(2) }).status, 'down');
  assert.equal(databaseStatus({ status: 'stopped', crashingSince: null }).status, 'maintenance');
});

test('the page is as bad as its worst component, but maintenance and unknown do not count as an outage', () => {
  assert.equal(overallStatus(['operational', 'operational']), 'operational');
  assert.equal(overallStatus(['operational', 'maintenance', 'unknown']), 'operational');
  assert.equal(overallStatus(['operational', 'degraded']), 'degraded');
  assert.equal(overallStatus(['degraded', 'down']), 'down');
  assert.equal(overallStatus([]), 'operational');
});

test('incidents open on a crash, close on the next ready pod, and merge when the gap is short', () => {
  const t = (min: number, toStatus: string, podName = 'web-1') => ({
    podName,
    toStatus,
    at: ago(min)
  });
  const incidents = incidentsFromTransitions(
    [
      t(120, 'crashing'),
      t(110, 'ready'),
      t(108, 'crashing'),
      t(100, 'ready'),
      t(30, 'crashing'),
      t(20, 'ready')
    ],
    null,
    NOW
  );
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].startedAt.toISOString(), ago(120).toISOString());
  assert.equal(incidents[0].endedAt?.toISOString(), ago(100).toISOString());
  assert.equal(incidents[1].startedAt.toISOString(), ago(30).toISOString());
  assert.equal(incidents[1].endedAt?.toISOString(), ago(20).toISOString());
});

test('the live crash state is the truth for the current incident', () => {
  const t = (min: number, toStatus: string) => ({ podName: 'web-1', toStatus, at: ago(min) });
  const ongoing = incidentsFromTransitions([t(30, 'crashing')], ago(35), NOW);
  assert.equal(ongoing.length, 1);
  assert.equal(ongoing[0].startedAt.toISOString(), ago(35).toISOString());
  assert.equal(ongoing[0].endedAt, null);
  const fresh = incidentsFromTransitions([], ago(4), NOW);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].endedAt, null);
  const stale = incidentsFromTransitions([t(30, 'crashing')], null, NOW);
  assert.equal(stale[0].endedAt?.toISOString(), NOW.toISOString());
});

test('the uptime strip charges each day only for the minutes an incident overlapped it', () => {
  const incident = {
    startedAt: new Date('2026-09-24T23:30:00.000Z'),
    endedAt: new Date('2026-09-25T00:30:00.000Z')
  };
  const bars = uptimeDays([incident], NOW, 3);
  assert.deepEqual(
    bars.map((b) => [b.day, b.status, b.downtimeMs / 60_000]),
    [
      ['2026-09-23', 'operational', 0],
      ['2026-09-24', 'degraded', 30],
      ['2026-09-25', 'degraded', 30]
    ]
  );
  const allDay = uptimeDays(
    [{ startedAt: new Date('2026-09-24T00:00:00.000Z'), endedAt: null }],
    NOW,
    2
  );
  assert.deepEqual(
    allDay.map((b) => b.status),
    ['down', 'down']
  );
  assert.equal(uptimePercent(uptimeDays([], NOW, 30), NOW), 100);
  assert.ok(uptimePercent(bars, NOW) < 100);
});

test('components are validated, deduplicated and capped, never trusted from the client as-is', () => {
  const out = normalizeComponents([
    { kind: 'deployment', resourceId: 'a', name: '  Web  ' },
    { kind: 'deployment', resourceId: 'a', name: 'dupe' },
    { kind: 'database', resourceId: 'b' },
    { kind: 'sandbox', resourceId: 'c' },
    'junk',
    { kind: 'deployment' }
  ]);
  assert.deepEqual(out, [
    { id: 'deployment:a', kind: 'deployment', resourceId: 'a', name: 'Web' },
    { id: 'database:b', kind: 'database', resourceId: 'b', name: '' }
  ]);
  assert.equal(normalizeComponents('nope').length, 0);
  assert.equal(
    normalizeComponents(
      Array.from({ length: 60 }, (_, i) => ({ kind: 'deployment', resourceId: String(i) }))
    ).length,
    40
  );
});
