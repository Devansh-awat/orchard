import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  databaseAnomalies,
  deploymentAnomalies,
  formatSize,
  rankAnomalies,
  type DeploymentFacts
} from '../src/anomalies/anomaly-rules';

const NOW = Date.parse('2026-09-28T12:00:00Z');

function facts(over: Partial<DeploymentFacts> = {}): DeploymentFacts {
  return {
    id: 'd1',
    name: 'cachet-db',
    stopped: false,
    replicas: 1,
    memoryBytes: 512 * 1024 ** 2,
    crashingSince: null,
    workload: { specReplicas: 1, readyReplicas: 1 },
    pods: [],
    alerts: [],
    failedRelease: null,
    applyError: null,
    buildStatus: 'succeeded',
    buildError: null,
    errorGroups: [],
    href: '/ysws/deployments/d1',
    ...over
  };
}

test('an app killed for memory in the last hour is critical and points at the limit', () => {
  const out = deploymentAnomalies(
    facts({
      pods: [
        {
          status: 'crashing',
          restartCount: 3,
          lastTerminationReason: 'OOMKilled',
          lastTerminatedAt: new Date(NOW - 5 * 60_000)
        }
      ],
      crashingSince: new Date(NOW - 10 * 60_000)
    }),
    NOW
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'oom');
  assert.equal(out[0].severity, 'critical');
  assert.equal(out[0].title, 'ran out of memory');
  assert.equal(out[0].resource.name, 'cachet-db');
  assert.equal(out[0].detail, 'Killed 3 times in the last hour, the limit is 512 MiB');
  assert.equal(out[0].action?.href, '/ysws/deployments/d1?tab=settings&s=resources');
});

test('an old memory kill is forgotten and a crash loop stands on its own', () => {
  const out = deploymentAnomalies(
    facts({
      pods: [
        {
          status: 'crashing',
          restartCount: 9,
          lastTerminationReason: 'Error',
          lastTerminatedAt: new Date(NOW - 3 * 60 * 60_000)
        }
      ],
      crashingSince: new Date(NOW - 60_000)
    }),
    NOW
  );
  assert.deepEqual(
    out.map((a) => a.kind),
    ['crashloop']
  );
});

test('a stopped app is quiet even with stale pod rows', () => {
  const out = deploymentAnomalies(
    facts({ stopped: true, workload: { specReplicas: 0, readyReplicas: 0 } }),
    NOW
  );
  assert.equal(out.length, 0);
});

test('severity orders the list and newer wins inside a tier', () => {
  const ranked = rankAnomalies([
    ...deploymentAnomalies(
      facts({
        alerts: [
          {
            label: 'CPU above 85%',
            lastValue: 93.4,
            firingSince: new Date(NOW - 60_000),
            unit: '%'
          }
        ],
        failedRelease: { reason: 'pods were not ready', createdAt: new Date(NOW - 30 * 60_000) },
        workload: { specReplicas: 2, readyReplicas: 1 }
      }),
      NOW
    ),
    ...databaseAnomalies(
      {
        id: 'db1',
        name: 'main',
        crashingSince: new Date(NOW - 120_000),
        pods: [
          {
            status: 'crashing',
            restartCount: 2,
            lastTerminationReason: 'Error',
            lastTerminatedAt: null
          }
        ],
        memoryBytes: null,
        href: '/ysws/databases/db1'
      },
      NOW
    )
  ]);
  assert.deepEqual(
    ranked.map((a) => a.kind),
    ['db_crashing', 'rollback', 'alert', 'under_replicated']
  );
  assert.equal(ranked[2].detail, 'Now 93.4%');
});

test('sizes read the way people say them', () => {
  assert.equal(formatSize(512 * 1024 ** 2), '512 MiB');
  assert.equal(formatSize(1.5 * 1024 ** 3), '1.5 GiB');
  assert.equal(formatSize(null), null);
});
