import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupFleetGauges } from '../src/projects/backup-telemetry';

const now = Date.parse('2026-10-07T22:00:00Z');
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

test('every archiving cluster gets a waiting count, an archiving flag and a backup age; stopped ones are skipped', () => {
  const clusters = [
    {
      metadata: { name: 'pg-a', namespace: 'ns', creationTimestamp: hoursAgo(100) },
      spec: { backup: { barmanObjectStore: {} } },
      status: {
        lastSuccessfulBackup: hoursAgo(3),
        conditions: [{ type: 'ContinuousArchiving', status: 'True' }]
      }
    },
    {
      metadata: { name: 'pg-b', namespace: 'ns', creationTimestamp: hoursAgo(72) },
      spec: { backup: { barmanObjectStore: {} } },
      status: { conditions: [{ type: 'ContinuousArchiving', status: 'False' }] }
    },
    {
      metadata: {
        name: 'pg-stopped',
        namespace: 'ns',
        annotations: { 'cnpg.io/hibernation': 'on' }
      },
      spec: { backup: { barmanObjectStore: {} } }
    },
    { metadata: { name: 'pg-nobackup', namespace: 'ns' }, spec: {} }
  ];
  const backups = [
    {
      metadata: { namespace: 'ns' },
      spec: { cluster: { name: 'pg-b' } },
      status: { phase: 'pending' }
    },
    { metadata: { namespace: 'ns' }, spec: { cluster: { name: 'pg-b' } }, status: null },
    {
      metadata: { namespace: 'ns' },
      spec: { cluster: { name: 'pg-b' } },
      status: { phase: 'completed' }
    },
    {
      metadata: { namespace: 'ns' },
      spec: { cluster: { name: 'pg-a' } },
      status: { phase: 'running' }
    }
  ];
  const gauges = backupFleetGauges(clusters, backups, now);
  const get = (metric: string, cluster: string) =>
    gauges.find((g) => g.metric === metric && g.tags.includes(`cnpg_cluster:${cluster}`))?.value;
  assert.equal(get('orchard.cnpg.backups_waiting', 'pg-a'), 1);
  assert.equal(get('orchard.cnpg.backups_waiting', 'pg-b'), 2);
  assert.equal(get('orchard.cnpg.archiving_failing', 'pg-a'), 0);
  assert.equal(get('orchard.cnpg.archiving_failing', 'pg-b'), 1);
  assert.equal(get('orchard.cnpg.hours_since_backup', 'pg-a'), 3);
  assert.equal(get('orchard.cnpg.hours_since_backup', 'pg-b'), 72);
  assert.equal(
    gauges.some((g) => g.tags.includes('cnpg_cluster:pg-stopped')),
    false
  );
  assert.equal(
    gauges.some(
      (g) =>
        g.tags.includes('cnpg_cluster:pg-nobackup') && g.metric === 'orchard.cnpg.backups_waiting'
    ),
    false
  );
  assert.deepEqual(gauges[0].tags, ['kube_namespace:ns', 'cnpg_cluster:pg-a']);
});

test('a cluster with no backups at all is reported unprotected instead of disappearing', () => {
  const clusters = [
    {
      metadata: { name: 'orchard-db', namespace: 'orchard', creationTimestamp: hoursAgo(2000) },
      spec: { instances: 3 },
      status: { readyInstances: 3 }
    },
    {
      metadata: { name: 'pg-dead', namespace: 'ns', creationTimestamp: hoursAgo(50) },
      spec: { instances: 1, backup: { barmanObjectStore: {} } },
      status: { readyInstances: 0, firstRecoverabilityPoint: hoursAgo(40) }
    },
    {
      metadata: { name: 'pg-new', namespace: 'ns', creationTimestamp: hoursAgo(0.1) },
      spec: { instances: 1, backup: { barmanObjectStore: {} } },
      status: { readyInstances: 0 }
    }
  ];
  const gauges = backupFleetGauges(clusters, [], now);
  const get = (metric: string, cluster: string) =>
    gauges.find((g) => g.metric === metric && g.tags.includes(`cnpg_cluster:${cluster}`))?.value;
  assert.equal(get('orchard.cnpg.unprotected', 'orchard-db'), 1);
  assert.equal(get('orchard.cnpg.down', 'orchard-db'), 0);
  assert.equal(get('orchard.cnpg.hours_since_backup', 'orchard-db'), undefined);
  assert.equal(get('orchard.cnpg.down', 'pg-dead'), 1);
  assert.equal(get('orchard.cnpg.unprotected', 'pg-dead'), 0);
  assert.equal(get('orchard.cnpg.down', 'pg-new'), 0);
  assert.equal(get('orchard.cnpg.unprotected', 'pg-new'), 0);
});
