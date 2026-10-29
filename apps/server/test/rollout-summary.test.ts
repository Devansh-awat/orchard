import assert from 'node:assert/strict';
import test from 'node:test';
import type * as k8s from '@kubernetes/client-node';
import { summarizeRollout } from '../src/kubernetes/rollout-strategy';

function rs(hash: string, number: number, replicas: number, ready = replicas): k8s.V1ReplicaSet {
  return {
    metadata: {
      name: `web-${hash}`,
      labels: { 'pod-template-hash': hash },
      annotations: { 'deployment.kubernetes.io/revision': String(number) },
      creationTimestamp: new Date(1_700_000_000_000 + number * 1000) as unknown as Date
    },
    spec: { template: { spec: { containers: [{ name: 'web', image: `web:${number}` }] } } },
    status: { replicas, readyReplicas: ready }
  } as k8s.V1ReplicaSet;
}

function dep(status: k8s.V1DeploymentStatus, replicas = 3, generation = 4): k8s.V1Deployment {
  return {
    metadata: { name: 'web', generation },
    spec: { replicas } as k8s.V1DeploymentSpec,
    status: { observedGeneration: generation, ...status }
  };
}

test('a settled deployment reports one live revision and stable', () => {
  const out = summarizeRollout(
    dep({ replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 }),
    [rs('aaa', 1, 0), rs('bbb', 2, 3)]
  );
  assert.equal(out.state, 'stable');
  assert.equal(out.currentRevision, 'bbb');
  assert.deepEqual(
    out.revisions.map((r) => r.hash),
    ['bbb']
  );
});

test('a rolling update keeps the old revision listed while the new one comes up', () => {
  const out = summarizeRollout(
    dep({ replicas: 4, updatedReplicas: 1, readyReplicas: 3, availableReplicas: 3 }),
    [rs('aaa', 1, 3), rs('bbb', 2, 1, 0)]
  );
  assert.equal(out.state, 'progressing');
  assert.equal(out.currentRevision, 'bbb');
  assert.deepEqual(
    out.revisions.map((r) => r.hash),
    ['bbb', 'aaa']
  );
});

test('two deploys in a second leave the newest revision current and the middle one draining', () => {
  const out = summarizeRollout(
    dep({ replicas: 5, updatedReplicas: 0, readyReplicas: 3, availableReplicas: 3 }, 3, 6),
    [rs('aaa', 1, 3), rs('bbb', 2, 1, 0), rs('ccc', 3, 1, 0)]
  );
  assert.equal(out.currentRevision, 'ccc');
  assert.equal(out.state, 'progressing');
  assert.deepEqual(
    out.revisions.map((r) => r.number),
    [3, 2, 1]
  );
});

test('the progress deadline marks the rollout failed even with old pods serving', () => {
  const out = summarizeRollout(
    dep({
      replicas: 4,
      updatedReplicas: 1,
      readyReplicas: 3,
      availableReplicas: 3,
      conditions: [
        {
          type: 'Progressing',
          status: 'False',
          reason: 'ProgressDeadlineExceeded'
        } as k8s.V1DeploymentCondition
      ]
    }),
    [rs('aaa', 1, 3), rs('bbb', 2, 1, 0)]
  );
  assert.equal(out.state, 'failed');
  assert.equal(out.reason, 'ProgressDeadlineExceeded');
});

test('a controller that has not seen the new spec yet is progressing', () => {
  const out = summarizeRollout(
    {
      ...dep({ replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 }),
      metadata: { name: 'web', generation: 5 }
    },
    [rs('bbb', 2, 3)]
  );
  assert.equal(out.state, 'progressing');
});
