import assert from 'node:assert/strict';
import test from 'node:test';
import type * as k8s from '@kubernetes/client-node';
import { summarizeBlueGreen, summarizeRollout } from '../src/kubernetes/rollout-strategy';

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

test('the previous revision is kept even after its pods are gone (recreate deploys)', () => {
  const out = summarizeRollout(
    dep({ replicas: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 }, 1),
    [rs('aaa', 1, 0), rs('bbb', 2, 1, 0)]
  );
  assert.equal(out.state, 'progressing');
  assert.equal(out.previous?.number, 1);
  assert.deepEqual(
    out.revisions.map((r) => r.hash),
    ['bbb']
  );
});

test('a green side makes the green revision current and the blue one previous', () => {
  const blue = summarizeRollout(
    dep({ replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 }, 2),
    [rs('aaa', 1, 2)]
  );
  const out = summarizeBlueGreen(
    blue,
    dep({ replicas: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 }, 2),
    [rs('ggg', 1, 1, 0)]
  );
  assert.equal(out.currentRevision, 'ggg');
  assert.equal(out.previous?.hash, 'aaa');
  assert.equal(out.revisions[0].number, 2);
  assert.equal(out.state, 'progressing');
});

test('a finished rollout whose pods later crash stays stable', () => {
  const out = summarizeRollout(
    dep(
      {
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 1,
        availableReplicas: 1,
        conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }]
      },
      2
    ),
    [rs('aaa', 1, 0), rs('bbb', 2, 2, 1)]
  );
  assert.equal(out.state, 'stable');
});

test('a quota failure is a reason, not a failed deploy', () => {
  const out = summarizeRollout(
    dep(
      {
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        conditions: [
          { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
          {
            type: 'ReplicaFailure',
            status: 'True',
            reason: 'FailedCreate',
            message: 'pods "web-x" is forbidden: exceeded quota: compute'
          }
        ]
      },
      3
    ),
    [rs('bbb', 2, 1, 1)]
  );
  assert.equal(out.state, 'stable');
  assert.match(out.reason ?? '', /exceeded quota/);
});

test('two deploys in a row keep the serving revision as previous', () => {
  const out = summarizeRollout(
    dep({ replicas: 3, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }, 1),
    [rs('aaa', 1, 1, 1), rs('bbb', 2, 1, 0), rs('ccc', 3, 1, 0)]
  );
  assert.equal(out.previous?.hash, 'aaa');
});
