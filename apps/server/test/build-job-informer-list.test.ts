import test from 'node:test';
import assert from 'node:assert/strict';
import type * as k8s from '@kubernetes/client-node';

import {
  BuildJobInformerService,
  observationFromJob
} from '../src/docker/build-job-informer.service';

const DEPLOYMENT = '6f9459bd-4252-49cb-a542-99be0ca7e592';
const OTHER = 'b3ee251d-fd0d-4eae-beb9-0d7d65bc4873';

function jobFor(over: {
  name: string;
  deploymentId?: string;
  createdAt?: string;
  active?: number;
  conditions?: { type: string; status: string; reason?: string }[];
  image?: string;
  legacyLabel?: boolean;
}): k8s.V1Job {
  const labelKey = over.legacyLabel ? 'orchard.dev/deployment-id' : 'orchard.my/deployment-id';
  return {
    metadata: {
      name: over.name,
      creationTimestamp: new Date(over.createdAt ?? '2026-09-22T03:27:42.000Z'),
      labels: { [labelKey]: over.deploymentId ?? DEPLOYMENT },
      annotations: over.image ? { 'orchard.my/full-image': over.image } : {}
    },
    status: {
      active: over.active,
      conditions: over.conditions
    }
  } as unknown as k8s.V1Job;
}

/** A service with a watch that is up, without starting a real one. */
function connectedInformer(): BuildJobInformerService {
  const service = new BuildJobInformerService();
  const internals = service as unknown as { informer: unknown; connected: boolean };
  internals.informer = {};
  internals.connected = true;
  return service;
}

function feed(service: BuildJobInformerService, ...jobs: k8s.V1Job[]) {
  const internals = service as unknown as { record(job: k8s.V1Job): void };
  for (const job of jobs) internals.record(job);
}

test('a running job reads as running, with its deployment and image', () => {
  const observation = observationFromJob(
    jobFor({
      name: 'image-builder-ysws-crescent-crescent-worker-abc',
      active: 1,
      image: 'harbor/orchard/app:abc'
    })
  );
  assert.equal(observation.phase, 'running');
  assert.equal(observation.deploymentId, DEPLOYMENT);
  assert.equal(observation.image, 'harbor/orchard/app:abc');
  assert.equal(observation.createdAt, new Date('2026-09-22T03:27:42.000Z').getTime());
});

test('a job with no active pods and no conditions is pending, not failed', () => {
  assert.equal(observationFromJob(jobFor({ name: 'j' })).phase, 'pending');
});

test('completion and failure conditions are read from the job, not guessed', () => {
  assert.equal(
    observationFromJob(jobFor({ name: 'j', conditions: [{ type: 'Complete', status: 'True' }] }))
      .phase,
    'succeeded'
  );
  const failed = observationFromJob(
    jobFor({
      name: 'j',
      conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }]
    })
  );
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.reason, 'BackoffLimitExceeded');
});

// A condition present but False is not a verdict. Reading only the type would
// call a running job finished.
test('a condition that is present but False is not terminal', () => {
  assert.equal(
    observationFromJob(
      jobFor({ name: 'j', active: 1, conditions: [{ type: 'Failed', status: 'False' }] })
    ).phase,
    'running'
  );
});

test('the watch answers which jobs a deployment has, newest first', () => {
  const service = connectedInformer();
  feed(
    service,
    jobFor({ name: 'older', createdAt: '2026-09-22T03:20:00.000Z', active: 1 }),
    jobFor({ name: 'newest', createdAt: '2026-09-22T03:27:42.000Z', active: 1 }),
    jobFor({ name: 'middle', createdAt: '2026-09-22T03:25:00.000Z', active: 1 })
  );

  const jobs = service.listForDeployment(DEPLOYMENT);
  assert.deepEqual(
    jobs?.map((j) => j.jobName),
    ['newest', 'middle', 'older']
  );
});

test('jobs belonging to other deployments are not returned', () => {
  const service = connectedInformer();
  feed(
    service,
    jobFor({ name: 'mine', active: 1 }),
    jobFor({ name: 'theirs', deploymentId: OTHER, active: 1 })
  );

  assert.deepEqual(
    service.listForDeployment(DEPLOYMENT)?.map((j) => j.jobName),
    ['mine']
  );
  assert.deepEqual(
    service.listForDeployment(OTHER)?.map((j) => j.jobName),
    ['theirs']
  );
});

// Jobs created before the label was renamed still belong to their deployment.
test('the legacy deployment-id label is still matched', () => {
  const service = connectedInformer();
  feed(service, jobFor({ name: 'old-label', legacyLabel: true, active: 1 }));
  assert.deepEqual(
    service.listForDeployment(DEPLOYMENT)?.map((j) => j.jobName),
    ['old-label']
  );
});

// The whole point of the null: an unhealthy watch must not report an empty
// list, because the caller would read that as "this build has no job".
test('a watch that is not up answers null, not an empty list', () => {
  const service = connectedInformer();
  feed(service, jobFor({ name: 'mine', active: 1 }));
  assert.equal(service.listForDeployment(DEPLOYMENT)?.length, 1);

  (service as unknown as { connected: boolean }).connected = false;
  assert.equal(service.listForDeployment(DEPLOYMENT), null);
  assert.equal(service.isHealthy(), false);
  // Still enabled: a watch exists, it is just not connected right now.
  assert.equal(service.isEnabled(), true);
});

test('an instance with no watch at all is not enabled, so callers fall back', () => {
  const service = new BuildJobInformerService();
  assert.equal(service.isEnabled(), false);
  assert.equal(service.isHealthy(), false);
});

test('a deleted job leaves a trace the sweep can tell from never having seen it', () => {
  const service = connectedInformer();
  const job = jobFor({ name: 'ttl-reaped', active: 1 });
  feed(service, job);
  assert.equal(service.hasSeen('ttl-reaped'), true);
  assert.equal(service.hasSeen('never-existed'), false);

  (service as unknown as { forget(j: k8s.V1Job): void }).forget(job);
  // Gone from the list, but the watch remembers being told so — that is the
  // difference between "the cluster says it is gone" and "we have no idea".
  assert.deepEqual(service.listForDeployment(DEPLOYMENT), []);
  assert.equal(service.hasSeen('ttl-reaped'), true);
});
