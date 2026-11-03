import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideBuildRecovery,
  needsRegistryProbe,
  isRequeueable,
  canTrustDeploymentStatus,
  REQUEUE_DETAIL,
  JOB_CREATE_GRACE_MS,
  CLAIM_SETTLE_MS,
  HEARTBEAT_STALE_MS,
  type RecoveryDeployment,
  type RecoveryFacts,
  type RecoveryJob,
  type RecoveryRun
} from '../src/projects/build-recovery';

const NOW = 1_790_047_722_484;

function run(over: Partial<RecoveryRun> = {}): RecoveryRun {
  return {
    isBuilding: true,
    workerId: 'server-5d59fffddf-76mj9-1',
    heartbeatAt: NOW - 1_000,
    triggerType: 'auto',
    detail: null,
    ...over
  };
}

function facts(
  over: {
    now?: number;
    deployment?: Partial<RecoveryDeployment>;
    run?: RecoveryRun | null;
    retryPending?: boolean;
    jobs?: RecoveryJob[] | null;
    workerAlive?: boolean | null;
    imagePushed?: boolean | null;
  } = {}
): RecoveryFacts {
  return {
    now: over.now ?? NOW,
    retryPending: over.retryPending ?? false,
    deployment: {
      buildStep: null,
      image: null,
      startedAt: NOW - 20_000,
      jobName: null,
      expectedImage: null,
      ...over.deployment
    },
    run: over.run === undefined ? run() : over.run,
    jobs: over.jobs === undefined ? [] : over.jobs,
    workerAlive: over.workerAlive ?? null,
    imagePushed: over.imagePushed ?? null
  };
}

function job(over: Partial<RecoveryJob> = {}): RecoveryJob {
  return {
    jobName: 'image-builder-ysws-crescent-crescent-worker-abc123',
    phase: 'running',
    reason: null,
    image: null,
    ...over
  };
}

// The regression this whole module exists for. crescent-worker, 2026-09-22:
// the reclaim sweep concluded the run 9s after it was claimed, the build path
// had not yet created a Job, and recovery read all of that as an orphan and
// failed a build that was running. Nothing here may return `fail`.
test('a build still in its prep phase, with its run already concluded, is deferred not failed', () => {
  const decision = decideBuildRecovery(
    facts({
      // 17s in: past the 15s stale window that let the sweep look at all.
      deployment: { startedAt: NOW - 17_000, buildStep: 'complete' },
      // Torn out by reclaim, so there is no run in `building` at all.
      run: run({ isBuilding: false, heartbeatAt: NOW - 61_000, workerId: null }),
      jobs: []
    })
  );
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'job_not_created_yet');
});

test('a build that never created a job within the grace goes back on the queue', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { startedAt: NOW - (JOB_CREATE_GRACE_MS + 1_000) },
      run: run({ isBuilding: false, workerId: null })
    })
  );
  assert.equal(decision.action, 'requeue');
  assert.equal(decision.reason, 'job_never_created');
});

test('a build already requeued once is failed rather than looped', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { startedAt: NOW - (JOB_CREATE_GRACE_MS + 1_000) },
      run: run({ isBuilding: false, workerId: null, detail: REQUEUE_DETAIL })
    })
  );
  assert.equal(decision.action, 'fail');
  assert.equal(decision.reason, 'job_never_created');
  assert.match(decision.detail!, /never created/);
});

// A deployment's first build is `initial`, and it goes back on the queue the same
// as `auto` and `manual`: it is the one build with nothing to fall back on, so it
// must not be the one that gets hard-failed.
test("a deployment's first build is requeueable", () => {
  assert.equal(isRequeueable(run({ triggerType: 'initial' })), true);
  assert.equal(isRequeueable(run({ triggerType: 'auto' })), true);
  assert.equal(isRequeueable(run({ triggerType: 'manual' })), true);
  assert.equal(isRequeueable(run({ triggerType: 'something-new' })), false);
  assert.equal(isRequeueable(null), false);

  const decision = decideBuildRecovery(
    facts({
      deployment: { startedAt: NOW - (JOB_CREATE_GRACE_MS + 1_000) },
      run: run({ isBuilding: false, workerId: null, triggerType: 'initial' })
    })
  );
  assert.equal(decision.action, 'requeue');
});

// The failure mode that makes every other branch dangerous: a watch that is
// down reports the same empty list as a deployment with no jobs.
test('no answer from the cluster is never read as no jobs', () => {
  const decision = decideBuildRecovery(
    facts({
      // Everything else says "orphaned": old, no run, a job was recorded.
      deployment: {
        startedAt: NOW - JOB_CREATE_GRACE_MS * 10,
        jobName: 'image-builder-gone',
        expectedImage: 'harbor/orchard/app:abc'
      },
      run: null,
      jobs: null
    })
  );
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'informer_unavailable');
});

test("a succeeded job's own image annotation wins over the one we asked for", () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { expectedImage: 'harbor/orchard/app:requested' },
      run: null,
      jobs: [job({ phase: 'succeeded', image: 'harbor/orchard/app:actual' })]
    })
  );
  assert.equal(decision.action, 'finish');
  assert.equal(decision.reason, 'job_succeeded');
  assert.equal(decision.image, 'harbor/orchard/app:actual');
});

test('a succeeded job with no annotation falls back to the requested image', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { expectedImage: 'harbor/orchard/app:requested' },
      run: null,
      jobs: [job({ phase: 'succeeded', image: null })]
    })
  );
  assert.equal(decision.action, 'finish');
  assert.equal(decision.image, 'harbor/orchard/app:requested');
});

test('a succeeded job with no image anywhere fails rather than deploying a guess', () => {
  const decision = decideBuildRecovery(
    facts({ run: null, jobs: [job({ phase: 'succeeded', image: null })] })
  );
  assert.equal(decision.action, 'fail');
  assert.equal(decision.reason, 'image_unknown');
});

test("a failed job carries the cluster's reason through", () => {
  const decision = decideBuildRecovery(
    facts({ run: null, jobs: [job({ phase: 'failed', reason: 'BackoffLimitExceeded' })] })
  );
  assert.equal(decision.action, 'fail');
  assert.equal(decision.reason, 'build_error');
  assert.match(decision.detail!, /BackoffLimitExceeded/);
});

test('a job the cluster still holds is adopted, not recovered', () => {
  for (const phase of ['running', 'pending'] as const) {
    const decision = decideBuildRecovery(facts({ run: null, jobs: [job({ phase })] }));
    assert.equal(decision.action, 'adopt', phase);
    assert.equal(decision.jobName, job().jobName);
  }
});

// The worker that owns a build is already waiting on its job and will
// conclude it from the same watch this sweep reads. Concluding it from here
// while that worker is alive races its finalizer, so a live worker outranks
// even a job the cluster has already finished.
test('a live worker finishes its own build, even once the job is terminal', () => {
  for (const phase of ['succeeded', 'failed'] as const) {
    const decision = decideBuildRecovery(
      facts({
        deployment: { expectedImage: 'harbor/orchard/app:abc' },
        run: run({ heartbeatAt: NOW - 1_000 }),
        workerAlive: true,
        jobs: [job({ phase })]
      })
    );
    assert.equal(decision.action, 'skip', phase);
  }
});

test('a beating worker we cannot disprove is left alone', () => {
  const decision = decideBuildRecovery(
    facts({ run: run({ heartbeatAt: NOW - 1_000 }), workerAlive: null })
  );
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'worker_alive');
});

test('a beating heartbeat from a pod that is provably gone does not protect a build', () => {
  const decision = decideBuildRecovery(
    facts({
      run: run({ heartbeatAt: NOW - 1_000 }),
      workerAlive: false,
      jobs: [job({ phase: 'running' })]
    })
  );
  assert.equal(decision.action, 'adopt');
});

test('a stale heartbeat does not protect a build', () => {
  const decision = decideBuildRecovery(
    facts({
      run: run({ heartbeatAt: NOW - (HEARTBEAT_STALE_MS + 1_000) }),
      jobs: [job({ phase: 'running' })]
    })
  );
  assert.equal(decision.action, 'adopt');
});

// The heartbeat on a concluded row keeps whatever value it had when the row
// was concluded, so it can look fresh. It describes a run that is over.
test("a concluded run's heartbeat does not read as a live build", () => {
  const decision = decideBuildRecovery(
    facts({
      run: run({ isBuilding: false, heartbeatAt: NOW - 1_000 }),
      jobs: [job({ phase: 'running' })]
    })
  );
  assert.equal(decision.action, 'adopt');
});

test('a build that already reached deploying only needs the image pointed at', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { buildStep: 'deploying', image: 'harbor/orchard/app:built' },
      run: null
    })
  );
  assert.equal(decision.action, 'finish');
  assert.equal(decision.reason, 'resume_deploy');
  assert.equal(decision.image, 'harbor/orchard/app:built');
});

// A deployment accumulates jobs across attempts. Adopting the newest when we
// know which one this build created deploys the wrong commit.
test('the job this build recorded wins over a newer unrelated one', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { jobName: 'mine' },
      run: null,
      jobs: [job({ jobName: 'someone-elses', phase: 'failed' }), job({ jobName: 'mine' })]
    })
  );
  assert.equal(decision.action, 'adopt');
  assert.equal(decision.jobName, 'mine');
});

test('a vanished job whose image did land in the registry finishes the deploy', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { jobName: 'gone', expectedImage: 'harbor/orchard/app:abc' },
      run: null,
      jobs: [],
      imagePushed: true
    })
  );
  assert.equal(decision.action, 'finish');
  assert.equal(decision.reason, 'image_pushed');
  assert.equal(decision.image, 'harbor/orchard/app:abc');
});

test('a registry we cannot reach is deferred, not assumed empty', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: { jobName: 'gone', expectedImage: 'harbor/orchard/app:abc' },
      run: null,
      jobs: [],
      imagePushed: null
    })
  );
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'registry_unreachable');
});

// A job that existed and is gone needs no grace: there is nothing left to
// wait for, unlike a build that has not created one yet.
test('a job that existed and vanished is recovered without waiting out the grace', () => {
  const decision = decideBuildRecovery(
    facts({
      deployment: {
        startedAt: NOW - 5_000,
        jobName: 'gone',
        expectedImage: 'harbor/orchard/app:abc'
      },
      run: run({ isBuilding: false, workerId: null }),
      jobs: [],
      imagePushed: false
    })
  );
  assert.equal(decision.action, 'requeue');
  assert.equal(decision.reason, 'job_missing');
});

test('a build with no timing information is deferred rather than guessed at', () => {
  const decision = decideBuildRecovery(
    facts({ deployment: { startedAt: null }, run: null, jobs: [] })
  );
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, 'job_not_created_yet');
});

// requeueOrphanedBuild schedules a fresh run and the queue picks it up on its
// own beat. A sweep landing in between must not conclude the build it is in
// the middle of retrying.
test('a build whose retry is already queued is left for that retry', () => {
  for (const deployment of [
    { startedAt: NOW - (JOB_CREATE_GRACE_MS + 1_000) },
    { startedAt: NOW - 5_000, jobName: 'gone', expectedImage: 'harbor/orchard/app:abc' }
  ]) {
    const decision = decideBuildRecovery(
      facts({
        deployment,
        // Not requeueable, so without the pending retry this would hard-fail.
        run: run({ isBuilding: false, workerId: null, detail: REQUEUE_DETAIL }),
        retryPending: true,
        jobs: [],
        imagePushed: false
      })
    );
    assert.equal(decision.action, 'defer');
    assert.equal(decision.reason, 'retry_pending');
  }
});

test('a registry probe is only worth spending when the answer can change the decision', () => {
  // No job listed and an image to look for: the probe decides it.
  assert.equal(
    needsRegistryProbe({ deployment: facts().deployment, jobs: [] }),
    false,
    'nothing to look for without an expected image'
  );
  assert.equal(
    needsRegistryProbe({
      deployment: { ...facts().deployment, expectedImage: 'harbor/orchard/app:abc' },
      jobs: []
    }),
    true
  );
  // A job is still listed, so its phase decides and the probe is wasted.
  assert.equal(
    needsRegistryProbe({
      deployment: { ...facts().deployment, expectedImage: 'harbor/orchard/app:abc' },
      jobs: [job()]
    }),
    false
  );
  // The cluster said nothing, so we are deferring regardless.
  assert.equal(
    needsRegistryProbe({
      deployment: { ...facts().deployment, expectedImage: 'harbor/orchard/app:abc' },
      jobs: null
    }),
    false
  );
});

// The reclaim guard. A run claimed seconds ago has a deployment status left
// over from the previous build; believing it is what concluded a live run.
test("a freshly claimed run's deployment status describes the previous build", () => {
  assert.equal(canTrustDeploymentStatus({ now: NOW, startedAt: NOW - 9_000 }), false);
  assert.equal(canTrustDeploymentStatus({ now: NOW, startedAt: NOW - 53_000 }), false);
  assert.equal(
    canTrustDeploymentStatus({ now: NOW, startedAt: NOW - (CLAIM_SETTLE_MS + 1_000) }),
    true
  );
  // A run with no start time gives nothing to measure, so it is not trusted.
  assert.equal(canTrustDeploymentStatus({ now: NOW, startedAt: null }), false);
});
