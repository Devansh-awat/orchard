import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideBuildRecovery,
  firecrackerRecoveryJobs,
  type RecoveryFacts
} from '../src/projects/build-recovery';

const NOW = 1_800_000_000_000;
const IMAGE = 'harbor.example/orchard/app:v1';

function facts(jobs: RecoveryFacts['jobs'], overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    now: NOW,
    deployment: {
      buildStep: 'building',
      image: null,
      startedAt: NOW - 10 * 60_000,
      jobName: 'dep-abc12345',
      expectedImage: IMAGE
    },
    run: {
      isBuilding: true,
      workerId: 'server-0-1',
      heartbeatAt: NOW - 5 * 60_000,
      triggerType: 'auto',
      detail: null
    },
    retryPending: false,
    jobs,
    workerAlive: false,
    imagePushed: false,
    ...overrides
  };
}

test('a running firecracker build is adopted', () => {
  const jobs = firecrackerRecoveryJobs({ status: 'running' }, 'dep-abc12345', IMAGE);
  assert.equal(decideBuildRecovery(facts(jobs)).action, 'adopt');
});

test('a finished firecracker build is finished with the recorded image', () => {
  const jobs = firecrackerRecoveryJobs({ status: 'succeeded' }, 'dep-abc12345', IMAGE);
  const decision = decideBuildRecovery(facts(jobs));
  assert.equal(decision.action, 'finish');
  assert.equal(decision.image, IMAGE);
});

test('a failed firecracker build fails with the host error', () => {
  const jobs = firecrackerRecoveryJobs(
    { status: 'failed', error: 'build step failed (exit 1)' },
    'dep-abc12345',
    IMAGE
  );
  const decision = decideBuildRecovery(facts(jobs));
  assert.equal(decision.action, 'fail');
  assert.match(decision.detail ?? '', /exit 1/);
});

test('only a live answer of gone makes a build orphaned, and orphans are requeued', () => {
  for (const status of ['not_found', 'unknown_host', { status: 'lost' as const }] as const) {
    const jobs = firecrackerRecoveryJobs(status, 'dep-abc12345', IMAGE);
    assert.deepEqual(jobs, []);
    assert.equal(decideBuildRecovery(facts(jobs)).action, 'requeue', JSON.stringify(status));
  }
});

test('an unreachable host defers instead of failing anything', () => {
  const jobs = firecrackerRecoveryJobs(null, 'dep-abc12345', IMAGE);
  assert.equal(jobs, null);
  assert.equal(decideBuildRecovery(facts(jobs)).action, 'defer');
});

test('a lost build whose image already landed is finished, not rebuilt', () => {
  const jobs = firecrackerRecoveryJobs({ status: 'lost' }, 'dep-abc12345', IMAGE);
  assert.equal(decideBuildRecovery(facts(jobs, { imagePushed: true })).action, 'finish');
});

test('a live worker is left alone whatever the host says', () => {
  const jobs = firecrackerRecoveryJobs('not_found', 'dep-abc12345', IMAGE);
  const decision = decideBuildRecovery(
    facts(jobs, {
      workerAlive: true,
      run: {
        isBuilding: true,
        workerId: 'server-0-1',
        heartbeatAt: NOW - 1_000,
        triggerType: 'auto',
        detail: null
      }
    })
  );
  assert.equal(decision.action, 'skip');
});
