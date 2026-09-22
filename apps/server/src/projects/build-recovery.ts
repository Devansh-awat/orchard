/**
 * Build recovery, as a decision separated from the IO that feeds it.
 *
 * The recovery sweep used to read liveness out of our own rows: a build was
 * "orphaned" when `deployments.build_status` said `building` and no Job came
 * back from a list call. Both halves of that were wrong in the same way. Our
 * rows lag the cluster by however long a build takes to write them, and a
 * failed list call is indistinguishable from a deployment that has no jobs.
 * A build in its first minute — still creating a check run, not yet holding a
 * Job — looked exactly like a build whose Job had vanished, and got failed
 * with "Build job not found after server restart" while it was running.
 *
 * So the cluster is the only thing allowed to say whether a build is alive
 * here, by way of the Job watch cache, and "the cluster did not answer" is a
 * distinct answer from "the cluster says there is nothing". Everything else is
 * a pure function over facts, which is what makes the branch that failed
 * crescent-worker something a test can pin down.
 */

export type ObservedJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export function isObservedJobStatus(status?: string | null): status is ObservedJobStatus {
  return (
    status === 'pending' || status === 'running' || status === 'succeeded' || status === 'failed'
  );
}

/** Stamped on a run we sent back to the queue, so it is only ever retried once. */
export const REQUEUE_DETAIL = 'Requeued after server restart';

/**
 * A heartbeat this fresh means the worker is mid-build. The queue beats every
 * 10s, so three misses.
 */
export const HEARTBEAT_STALE_MS = 30_000;

/**
 * How long a build may hold `building` without having created a Job before we
 * treat it as dead rather than starting. Deliberately longer than the queue's
 * own 4-minute "did not start" timeout, so that path — which knows why it gave
 * up — gets to conclude the build first, and this one only catches builds
 * whose run row was lost before it could.
 */
export const JOB_CREATE_GRACE_MS = 6 * 60_000;

/**
 * How long after a run is claimed before its deployment's `build_status` is
 * worth believing. Claim and deployment row are written together now, but a
 * row from before that, or from a path that still writes them apart, must not
 * be read as finished just because the build has not got round to saying it
 * started.
 */
export const CLAIM_SETTLE_MS = 2 * 60_000;

/** A build Job, as the cluster reports it. */
export interface RecoveryJob {
  jobName: string;
  phase: ObservedJobStatus;
  reason: string | null;
  /** The image the Job annotated itself with, which beats anything we guessed. */
  image: string | null;
}

export interface RecoveryDeployment {
  buildStep: string | null;
  image: string | null;
  /** `__start` from buildStepTimestamps: when this build began. */
  startedAt: number | null;
  /** `__jobName`, written only once a Job exists. Null means none ever did. */
  jobName: string | null;
  /** `__image`, the tag the Job was told to push. */
  expectedImage: string | null;
}

export interface RecoveryRun {
  /** False for a run that has already been concluded, which must not read as live. */
  isBuilding: boolean;
  workerId: string | null;
  heartbeatAt: number | null;
  triggerType: string;
  detail: string | null;
}

export interface RecoveryFacts {
  now: number;
  deployment: RecoveryDeployment;
  /** The run in `building`, else the newest run, else null. */
  run: RecoveryRun | null;
  /**
   * Is a run already sitting in `scheduled` for this deployment? If so a
   * retry is queued and recovery has nothing left to decide — failing here
   * would kill the attempt that is about to start.
   */
  retryPending: boolean;
  /** Jobs the cluster holds for this deployment. `null` = it did not answer. */
  jobs: RecoveryJob[] | null;
  /** Does the pod that claimed the run still exist? `null` = cannot tell. */
  workerAlive: boolean | null;
  /** Is `expectedImage` already in the registry? `null` = unknown/not probed. */
  imagePushed: boolean | null;
}

export type RecoveryAction = 'skip' | 'defer' | 'adopt' | 'finish' | 'requeue' | 'fail';

export type RecoveryReason =
  | 'worker_alive'
  | 'informer_unavailable'
  | 'registry_unreachable'
  | 'job_not_created_yet'
  | 'retry_pending'
  | 'resume_deploy'
  | 'job_succeeded'
  | 'image_pushed'
  | 'job_running'
  | 'build_error'
  | 'image_unknown'
  | 'job_never_created'
  | 'job_missing';

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: RecoveryReason;
  /** Set for `finish`. */
  image?: string;
  /** Set whenever a specific Job drove the decision. */
  jobName?: string;
  /** Operator-facing text, set for `fail`. */
  detail?: string;
}

/**
 * True when the decision will turn on whether the image already made it to the
 * registry, so the caller knows to spend a registry call before deciding — and
 * only then. A build whose Job is still listed never needs this.
 */
export function needsRegistryProbe(facts: Pick<RecoveryFacts, 'deployment' | 'jobs'>): boolean {
  if (facts.jobs === null) return false;
  if (!facts.deployment.expectedImage) return false;
  return pickJob(facts.jobs, facts.deployment.jobName) === null;
}

/**
 * The Job this build is about: the one it recorded by name, else the newest.
 * The recorded name wins because a deployment can accumulate Jobs from earlier
 * attempts, and adopting the wrong one deploys the wrong commit.
 */
function pickJob(jobs: RecoveryJob[], recordedName: string | null): RecoveryJob | null {
  if (recordedName) {
    const byName = jobs.find((job) => job.jobName === recordedName);
    if (byName) return byName;
  }
  return jobs[0] ?? null;
}

/** Can this run go back on the queue instead of being failed outright? */
export function isRequeueable(run: RecoveryRun | null): boolean {
  if (!run) return false;
  // Already sent back once. Requeueing again would loop.
  if (run.detail === REQUEUE_DETAIL) return false;
  return (
    run.triggerType === 'auto' || run.triggerType === 'manual' || run.triggerType === 'initial'
  );
}

/**
 * Whether a run is old enough that its deployment's `build_status` describes
 * the same build. Guards the reclaim sweep: a run claimed moments ago has not
 * reached the write that sets the deployment to `building`, so a `succeeded`
 * there belongs to the *previous* build and says nothing about this one.
 */
export function canTrustDeploymentStatus(opts: {
  now: number;
  startedAt: number | null;
  settleMs?: number;
}): boolean {
  if (opts.startedAt === null) return false;
  return opts.now - opts.startedAt >= (opts.settleMs ?? CLAIM_SETTLE_MS);
}

export function decideBuildRecovery(facts: RecoveryFacts): RecoveryDecision {
  const { now, deployment, run, jobs } = facts;

  // A run whose worker is still beating, and whose pod we cannot disprove, is
  // a build in progress. Nothing to recover.
  if (
    run?.isBuilding &&
    run.workerId &&
    run.heartbeatAt !== null &&
    now - run.heartbeatAt < HEARTBEAT_STALE_MS &&
    facts.workerAlive !== false
  ) {
    return { action: 'skip', reason: 'worker_alive' };
  }

  // No word from the cluster. An empty list and a broken watch look identical
  // from here, and one of them means "fail a running build".
  if (jobs === null) {
    return { action: 'defer', reason: 'informer_unavailable' };
  }

  // The image is already built and recorded; this build only ever needed the
  // cluster to be pointed at it.
  if (deployment.buildStep === 'deploying' && deployment.image) {
    return { action: 'finish', reason: 'resume_deploy', image: deployment.image };
  }

  const job = pickJob(jobs, deployment.jobName);
  if (job) {
    if (job.phase === 'succeeded') {
      // The Job's own annotation is canonical; `__image` is what we asked for.
      const image = job.image ?? deployment.expectedImage;
      if (!image) {
        return {
          action: 'fail',
          reason: 'image_unknown',
          jobName: job.jobName,
          detail: 'Build succeeded but the image it pushed could not be determined'
        };
      }
      return { action: 'finish', reason: 'job_succeeded', image, jobName: job.jobName };
    }
    if (job.phase === 'failed') {
      return {
        action: 'fail',
        reason: 'build_error',
        jobName: job.jobName,
        detail: job.reason ? `Build job failed: ${job.reason}` : 'Build job failed'
      };
    }
    return { action: 'adopt', reason: 'job_running', jobName: job.jobName };
  }

  // No Job. If the image it was meant to push is already in the registry, the
  // build did finish and only the bookkeeping was lost.
  if (facts.imagePushed === true && deployment.expectedImage) {
    return { action: 'finish', reason: 'image_pushed', image: deployment.expectedImage };
  }
  if (facts.imagePushed === null && deployment.expectedImage) {
    return { action: 'defer', reason: 'registry_unreachable' };
  }

  // This build is over; the only question left is whether it gets another go.
  const resolveOrphan = (
    reason: Extract<RecoveryReason, 'job_never_created' | 'job_missing'>,
    detail: string,
    jobName?: string
  ): RecoveryDecision => {
    // A retry is already queued, so there is nothing to decide and something
    // to lose by deciding it.
    if (facts.retryPending) return { action: 'defer', reason: 'retry_pending' };
    // `detail` rides along on the requeue too: if the requeue turns out to be
    // impossible once it reaches the database, the caller fails with the real
    // reason rather than a generic one.
    return isRequeueable(run)
      ? { action: 'requeue', reason, detail, jobName }
      : { action: 'fail', reason, detail, jobName };
  };

  // No Job was ever recorded for this build. Either it is still in its prep
  // phase — resolving the installation, opening a check run, none of which
  // touches the cluster — or it died there. Only elapsed time tells them
  // apart, and getting this wrong is what failed a live build.
  if (deployment.jobName === null) {
    const age = deployment.startedAt === null ? null : now - deployment.startedAt;
    if (age === null || age < JOB_CREATE_GRACE_MS) {
      return { action: 'defer', reason: 'job_not_created_yet' };
    }
    return resolveOrphan('job_never_created', 'The build never created its build job');
  }

  // A Job existed and is gone, with nothing in the registry to show for it.
  return resolveOrphan(
    'job_missing',
    'The build job disappeared before it pushed an image',
    deployment.jobName
  );
}
