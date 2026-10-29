import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditChange,
  auditChangeKind,
  clusterEventChange,
  mergeChanges,
  releaseChange,
  versionLabel
} from '../src/observability/changes';
import { describeAuditMetadata } from '../src/observability/timeline-entries';
import { classifyEvent, deploymentNameFromPod } from '../src/engine/consumers/event.consumer';
import { nodeTransitions } from '../src/nodes/node-transitions';

test('audit actions map to change kinds and noise is dropped', () => {
  assert.equal(auditChangeKind('deployment.resources.updated'), 'resources');
  assert.equal(auditChangeKind('deployment.env.updated'), 'env');
  assert.equal(auditChangeKind('deployment.scaled'), 'scale');
  assert.equal(auditChangeKind('deployment.rolled_back'), 'rollback');
  assert.equal(auditChangeKind('deployment.image.updated'), 'config');
  assert.equal(auditChangeKind('deployment.placement.updated'), 'config');
  assert.equal(auditChangeKind('ingress.created'), 'domain');
  assert.equal(auditChangeKind('deployment.redeployed'), null);
  assert.equal(auditChangeKind('webhook_token.created'), null);
});

test('resource audit metadata reads in units, not raw numbers', () => {
  assert.equal(
    describeAuditMetadata({
      cpuMilli: [250, 1000],
      memoryBytes: [256 * 1024 * 1024, 2 * 1024 ** 3]
    }),
    'cpu 250m → 1 CPU · memory 256 MB → 2 GB'
  );
  assert.equal(
    describeAuditMetadata({ memoryBytes: [null, 512 * 1024 * 1024] }),
    'memory default → 512 MB'
  );
  assert.equal(describeAuditMetadata({ cpuMilli: [500, 500] }), null);
});

test('an audit row becomes a config-toned marker with its own title', () => {
  const change = auditChange({
    id: 'a1',
    action: 'deployment.resources.updated',
    createdAt: new Date(1000),
    targetType: 'deployment',
    targetLabel: 'api',
    metadata: { memoryBytes: [256 * 1024 * 1024, 512 * 1024 * 1024] }
  });
  assert.deepEqual(change, {
    id: 'audit:a1',
    t: 1000,
    kind: 'resources',
    tone: 'config',
    label: 'Resources changed',
    detail: 'memory 256 MB → 512 MB',
    cause: 'the memory limit changed'
  });
});

test('version labels prefer what the user named', () => {
  assert.equal(versionLabel({ tag: '1.8.2', commitSha: null }), '1.8.2');
  assert.equal(versionLabel({ tag: 'v1730000000123', commitSha: 'abcdef1234' }), 'abcdef1');
  assert.equal(versionLabel({ tag: null, commitSha: null }), 'new version');
});

test('releases become deploy markers and rollbacks say so', () => {
  const live = releaseChange({
    id: 'r1',
    promotedAt: new Date(5000),
    status: 'live',
    reason: null,
    image: 'reg/app:1.2',
    imageHistory: { tag: '1.2', commitSha: null, commitMessage: 'Fix navbar\n\nlong body' }
  });
  assert.equal(live.label, '1.2 went live');
  assert.equal(live.detail, 'Fix navbar');
  assert.equal(live.tone, 'deploy');
  const back = releaseChange({
    id: 'r2',
    promotedAt: new Date(6000),
    status: 'rolled_back',
    reason: null,
    image: 'reg/app:1.1',
    imageHistory: null
  });
  assert.equal(back.kind, 'rollback');
  assert.equal(back.label, 'Rolled back to 1.1');
});

test('cluster events read as platform changes', () => {
  const change = clusterEventChange({
    id: 'c1',
    kind: 'eviction',
    reason: 'Evicted',
    message: 'The node was low on resource: memory.',
    nodeName: 'house',
    count: 3,
    at: new Date(42)
  });
  assert.equal(change.tone, 'platform');
  assert.equal(change.label, 'Pod evicted');
  assert.equal(change.detail, 'The node was low on resource: memory. · on house · 3 times');
});

test('merge sorts ascending and keeps the newest when capped', () => {
  const mk = (id: string, t: number) => ({
    id,
    t,
    kind: 'deploy' as const,
    tone: 'deploy' as const,
    label: id,
    detail: null,
    actor: null
  });
  const merged = mergeChanges(
    [
      [mk('b', 2), mk('d', 4)],
      [mk('a', 1), mk('c', 3)]
    ],
    3
  );
  assert.deepEqual(
    merged.map((c) => c.id),
    ['b', 'c', 'd']
  );
});

const baseEvent = {
  metadata: { uid: 'u1', namespace: 'ysws-terra' },
  involvedObject: { kind: 'Pod', name: 'api-7d9f8c6b5-x2k4p', namespace: 'ysws-terra' },
  firstTimestamp: new Date('2026-10-28T10:00:00Z'),
  lastTimestamp: new Date('2026-10-28T10:05:00Z'),
  count: 2,
  source: { host: 'house' }
};

test('only events that explain trouble are kept', () => {
  const evicted = classifyEvent({ ...baseEvent, reason: 'Evicted', message: 'low memory' } as any);
  assert.equal(evicted?.kind, 'eviction');
  assert.equal(evicted?.key, 'event:u1');
  assert.equal(evicted?.count, 2);
  assert.equal(evicted?.nodeName, 'house');
  assert.equal(classifyEvent({ ...baseEvent, reason: 'Pulled', message: 'ok' } as any), null);
  assert.equal(
    classifyEvent({ ...baseEvent, reason: 'Killing', message: 'Stopping container api' } as any),
    null
  );
  assert.equal(
    classifyEvent({
      ...baseEvent,
      reason: 'Killing',
      message: 'Container api failed liveness probe, will be restarted'
    } as any)?.kind,
    'killing'
  );
  assert.equal(
    classifyEvent({
      ...baseEvent,
      reason: 'Evicted',
      involvedObject: { kind: 'Node', name: 'house' }
    } as any),
    null
  );
});

test('pod names fall back to their deployment name', () => {
  assert.equal(deploymentNameFromPod('api-7d9f8c6b5-x2k4p'), 'api');
  assert.equal(deploymentNameFromPod('game-server-7d9f8c6b5-x2k4p'), 'game-server');
  assert.equal(deploymentNameFromPod('solo'), null);
});

test('node transitions report cordons and new pressure only', () => {
  const taint = (key: string) => ({ key, value: null, effect: 'NoSchedule' });
  assert.deepEqual(nodeTransitions('house', null, { schedulable: false, taints: [] }), []);
  assert.deepEqual(
    nodeTransitions('house', { schedulable: true, taints: [] }, { schedulable: false, taints: [] }),
    [{ reason: 'Cordoned', message: 'Node house was cordoned' }]
  );
  assert.deepEqual(
    nodeTransitions(
      'house',
      { schedulable: true, taints: [taint('node.kubernetes.io/disk-pressure')] },
      {
        schedulable: true,
        taints: [
          taint('node.kubernetes.io/disk-pressure'),
          taint('node.kubernetes.io/memory-pressure')
        ]
      }
    ),
    [{ reason: 'MemoryPressure', message: 'Node house is low on memory' }]
  );
  assert.deepEqual(
    nodeTransitions('house', { schedulable: false, taints: [] }, { schedulable: true, taints: [] }),
    [{ reason: 'Uncordoned', message: 'Node house was uncordoned' }]
  );
});

test('audit causes name what the user changed', () => {
  const row = (action: string, metadata: unknown, targetLabel: string | null = null) =>
    auditChange({
      id: 'x',
      action,
      createdAt: new Date(0),
      targetType: 'deployment',
      targetLabel,
      metadata
    })?.cause;
  assert.equal(
    row('deployment.env.updated', { changed: 'API_URL', added: null }),
    'API_URL changed'
  );
  assert.equal(
    row('deployment.env.updated', { changed: 'A,B', added: 'C' }),
    '3 environment variables changed'
  );
  assert.equal(
    row('deployment.resources.updated', { cpuMilli: [250, 500], memoryBytes: [1, 1] }),
    'the CPU limit changed'
  );
  assert.equal(row('deployment.scaled', { replicas: [1, 3] }), 'the app was scaled to 3');
  assert.equal(
    row('deployment.strategy.updated', { strategy: ['rollingUpdate', 'recreate'] }),
    'the deploy strategy changed'
  );
  assert.equal(row('ingress.created', null, 'api.example.com'), 'api.example.com changed');
});

test('cluster causes read as clauses', () => {
  const base = { id: 'c', message: null, count: 1, at: new Date(0) };
  assert.equal(
    clusterEventChange({ ...base, kind: 'node', reason: 'MemoryPressure', nodeName: 'house' })
      .cause,
    'the node house ran low on memory'
  );
  assert.equal(
    clusterEventChange({ ...base, kind: 'eviction', reason: 'Evicted', nodeName: 'house' }).cause,
    'a pod was evicted'
  );
});
