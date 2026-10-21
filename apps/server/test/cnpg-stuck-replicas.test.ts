import test from 'node:test';
import assert from 'node:assert/strict';
import { stuckReplicas, SURPLUS_GRACE_MS } from '../src/kubernetes/cnpg-stuck-replicas';

const NOW = Date.parse('2026-10-21T03:00:00Z');
const OLD = new Date(NOW - 50 * 24 * 3600_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

const pvc = (instance: string, status: string, created = OLD) => ({
  metadata: {
    name: instance,
    labels: { 'cnpg.io/instanceName': instance, 'cnpg.io/pvcRole': 'PG_DATA' },
    annotations: { 'cnpg.io/pvcStatus': status },
    creationTimestamp: created
  }
});

const job = (name: string, instance: string, state: 'failed' | 'active' | 'done') => ({
  metadata: { name, labels: { 'cnpg.io/instanceName': instance } },
  status:
    state === 'active'
      ? { active: 1 }
      : { conditions: [{ type: state === 'failed' ? 'Failed' : 'Complete', status: 'True' }] }
});

test('a replica whose join job failed is cleared so the operator can bring the primary back', () => {
  const out = stuckReplicas({
    cluster: {
      spec: { instances: 2 },
      status: { currentPrimary: 'pg-dev-db-1', readyInstances: 0 }
    },
    pvcs: [pvc('pg-dev-db-1', 'ready'), pvc('pg-dev-db-2', 'initializing')],
    jobs: [job('pg-dev-db-2-join', 'pg-dev-db-2', 'failed')],
    pods: [],
    now: NOW
  });
  assert.deepEqual(out, [
    {
      instance: 'pg-dev-db-2',
      pvcs: ['pg-dev-db-2'],
      jobs: ['pg-dev-db-2-join'],
      reason: 'join_failed'
    }
  ]);
});

test('a leftover initializing volume beyond the instance count is surplus', () => {
  const out = stuckReplicas({
    cluster: {
      spec: { instances: 1 },
      status: { currentPrimary: 'pg-stern-1', readyInstances: 1 }
    },
    pvcs: [pvc('pg-stern-1', 'ready'), pvc('pg-stern-2', 'initializing')],
    jobs: [],
    pods: [{ metadata: { name: 'pg-stern-1' } }],
    now: NOW
  });
  assert.deepEqual(out, [
    { instance: 'pg-stern-2', pvcs: ['pg-stern-2'], jobs: [], reason: 'surplus' }
  ]);
});

test('a join in progress, a fresh volume, the primary and ready volumes are never touched', () => {
  const base = {
    cluster: { spec: { instances: 2 }, status: { currentPrimary: 'db-1', readyInstances: 1 } },
    pods: [{ metadata: { name: 'db-1' } }],
    now: NOW
  };
  assert.deepEqual(
    stuckReplicas({
      ...base,
      pvcs: [pvc('db-2', 'initializing')],
      jobs: [job('db-2-join', 'db-2', 'active')]
    }),
    []
  );
  assert.deepEqual(
    stuckReplicas({
      ...base,
      cluster: { spec: { instances: 1 }, status: { currentPrimary: 'db-1', readyInstances: 1 } },
      pvcs: [pvc('db-2', 'initializing', FRESH)],
      jobs: []
    }),
    []
  );
  assert.deepEqual(
    stuckReplicas({
      ...base,
      pvcs: [pvc('db-1', 'initializing')],
      jobs: [job('db-1-join', 'db-1', 'failed')]
    }),
    []
  );
  assert.deepEqual(stuckReplicas({ ...base, pvcs: [pvc('db-3', 'ready')], jobs: [] }), []);
});

test('a missing replica the cluster still needs is left for the operator', () => {
  const out = stuckReplicas({
    cluster: { spec: { instances: 2 }, status: { currentPrimary: 'db-1', readyInstances: 1 } },
    pvcs: [pvc('db-2', 'initializing')],
    jobs: [],
    pods: [{ metadata: { name: 'db-1' } }],
    now: NOW + SURPLUS_GRACE_MS
  });
  assert.deepEqual(out, []);
});

test('only failed joins count, not a failed recovery or initdb', () => {
  const out = stuckReplicas({
    cluster: { spec: { instances: 2 }, status: { currentPrimary: 'db-1', readyInstances: 1 } },
    pvcs: [pvc('db-2', 'initializing')],
    jobs: [job('db-2-full-recovery', 'db-2', 'failed')],
    pods: [],
    now: NOW
  });
  assert.deepEqual(out, []);
});
