import assert from 'node:assert/strict';
import test from 'node:test';
import type * as k8s from '@kubernetes/client-node';
import { computePodStatus, podFacts, podRecord } from '../src/engine/pod-status';

const base = (status: k8s.V1PodStatus, extra: Partial<k8s.V1Pod> = {}): k8s.V1Pod => ({
  metadata: {
    name: 'web-abc-1',
    creationTimestamp: new Date('2026-10-28T10:00:00Z') as unknown as Date,
    labels: { 'pod-template-hash': 'abc' }
  },
  spec: { containers: [{ name: 'web', image: 'web:1', livenessProbe: {} }] },
  status,
  ...extra
});

test('an init container in back-off makes the pod crashing', () => {
  const pod = base(
    {
      phase: 'Pending',
      initContainerStatuses: [
        {
          name: 'migrate',
          image: 'web:1',
          imageID: '',
          ready: false,
          restartCount: 3,
          state: { waiting: { reason: 'CrashLoopBackOff' } }
        }
      ]
    },
    {
      spec: {
        initContainers: [{ name: 'migrate', image: 'web:1' }],
        containers: [{ name: 'web', image: 'web:1' }]
      }
    }
  );
  assert.equal(computePodStatus(pod), 'crashing');
  const facts = podFacts(pod);
  assert.equal(facts.containers[0].init, true);
  assert.equal(facts.containers[0].reason, 'CrashLoopBackOff');
});

test('an evicted pod reports its reason', () => {
  const facts = podFacts(base({ phase: 'Failed', reason: 'Evicted', message: 'low memory' }));
  assert.equal(facts.reason, 'Evicted');
  assert.equal(facts.phase, 'Failed');
});

test('scheduling and readiness carry the time they changed', () => {
  const facts = podFacts(
    base({
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/3 nodes are available: 3 Insufficient memory.',
          lastTransitionTime: new Date('2026-10-28T10:00:05Z') as unknown as Date
        }
      ]
    })
  );
  assert.equal(facts.scheduled, false);
  assert.equal(facts.unschedulableSince, '2026-10-28T10:00:05.000Z');
  assert.match(facts.schedulingMessage ?? '', /Insufficient memory/);
});

test('the record carries revision, probes and container state', () => {
  const rec = podRecord(
    base({
      phase: 'Running',
      containerStatuses: [
        {
          name: 'web',
          image: 'web:1',
          imageID: '',
          ready: true,
          restartCount: 1,
          state: { running: { startedAt: new Date('2026-10-28T10:01:00Z') as unknown as Date } },
          lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } }
        }
      ]
    })
  );
  assert.equal(rec.revision, 'abc');
  assert.equal(rec.probes.liveness, true);
  assert.equal(rec.containers[0].state, 'running');
  assert.equal(rec.containers[0].lastTermination?.reason, 'OOMKilled');
});
