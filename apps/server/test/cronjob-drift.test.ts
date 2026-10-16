import test from 'node:test';
import assert from 'node:assert/strict';
import { cronJobForReplace } from '../src/jobs/cronjob-drift';

const desired = () =>
  ({
    metadata: {
      name: 'ojob-1234abcd',
      namespace: 'acme',
      labels: {
        'app.kubernetes.io/managed-by': 'orchard-job',
        'orchard/job-id': 'j1',
        'orchard/project-id': 'p1'
      },
      annotations: { 'orchard/spec-hash': 'new' }
    },
    spec: { schedule: '0 * * * *', suspend: false, jobTemplate: {} }
  }) as any;

test('a replace keeps labels and annotations added outside orchard', () => {
  const live = {
    metadata: {
      resourceVersion: '42',
      labels: { team: 'payments', 'orchard/job-id': 'j1' },
      annotations: {
        'orchard/spec-hash': 'old',
        'example.com/owner': 'ops',
        'kubectl.kubernetes.io/last-applied-configuration': '{}'
      }
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.resourceVersion, '42');
  assert.deepEqual(out.metadata!.labels, {
    team: 'payments',
    'app.kubernetes.io/managed-by': 'orchard-job',
    'orchard/job-id': 'j1',
    'orchard/project-id': 'p1'
  });
  assert.equal(out.metadata!.annotations!['orchard/spec-hash'], 'new');
  assert.equal(out.metadata!.annotations!['example.com/owner'], 'ops');
  assert.equal(
    out.metadata!.annotations!['kubectl.kubernetes.io/last-applied-configuration'],
    '{}'
  );
});

test('orchard keys orchard no longer writes are dropped, not carried forward', () => {
  const live = {
    metadata: {
      labels: { 'orchard/legacy': 'x' },
      annotations: { 'orchard/retired': 'y' }
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.labels!['orchard/legacy'], undefined);
  assert.equal(out.metadata!.annotations!['orchard/retired'], undefined);
});

test('orchard always wins on the keys it owns', () => {
  const live = {
    metadata: {
      labels: { 'app.kubernetes.io/managed-by': 'someone-else' },
      annotations: {}
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.labels!['app.kubernetes.io/managed-by'], 'orchard-job');
});

test('the desired object is not mutated', () => {
  const d = desired();
  cronJobForReplace(d, { metadata: { resourceVersion: '1', labels: { a: 'b' } } } as any);
  assert.equal(d.metadata.resourceVersion, undefined);
  assert.equal(d.metadata.labels.a, undefined);
});
