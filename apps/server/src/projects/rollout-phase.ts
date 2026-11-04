import { POD_BACKOFF_REASONS, computePodStatus } from '../engine/pod-status';
import { isQuotaFailure, quotaHint } from '../health/health.generated';

export type RolloutPhase =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'live'
  | 'build_failed'
  | 'crashing'
  | 'unhealthy'
  | 'stopped';

export const TERMINAL_PHASES: ReadonlySet<RolloutPhase> = new Set([
  'live',
  'build_failed',
  'crashing',
  'unhealthy',
  'stopped'
]);

export const PIN_GRACE_MS = 20_000;
export const INTENT_GRACE_MS = 120_000;
const CRASH_RESTART_THRESHOLD = 5;
export const QUOTA_PATIENCE_MS = 60_000;

export interface RolloutDeploymentRow {
  stopped: boolean;
  replicas: number;
  image: string | null;
  buildStatus: string | null;
  buildStep: string | null;
  buildError: string | null;
  updatedAt: Date;
}

export interface RolloutPin {
  since: Date;
  image: string | null;
  releaseStatus: string | null;
  releaseReason: string | null;
}

export interface RolloutState {
  deployment: RolloutDeploymentRow;
  activeBuildRun: { status: string } | null;
  lastBuildFinishedAt: Date | null;
  workload: { manifest: any; syncedAt: Date | null } | null;
  pods: any[];
  pin: RolloutPin | null;
  now: Date;
}

export interface FailingPod {
  pod: string;
  container: string | null;
  reason: string;
  message: string | null;
  exitCode: number | null;
  restarts: number;
}

export interface RolloutVerdict {
  phase: RolloutPhase;
  terminal: boolean;
  desired: number;
  ready: number;
  failing: FailingPod[];
  hint: string | null;
}

function imageKey(image: string | null | undefined): string {
  if (!image) return '';
  const last = image.split('/').pop() ?? image;
  return last.includes(':') || last.includes('@') ? last : `${last}:latest`;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function podRestarts(pod: any): number {
  return (pod?.status?.containerStatuses ?? []).reduce(
    (sum: number, c: any) => sum + (typeof c?.restartCount === 'number' ? c.restartCount : 0),
    0
  );
}

export function describeFailingPod(pod: any): FailingPod | null {
  const status = computePodStatus(pod);
  if (status === 'terminating' || status === 'succeeded') return null;
  const restarts = podRestarts(pod);
  const crashing = status === 'crashing';
  const flapping = restarts > CRASH_RESTART_THRESHOLD && status !== 'ready';
  if (!crashing && !flapping) return null;
  const statuses: any[] = pod?.status?.containerStatuses ?? [];
  const stuck =
    statuses.find((c) =>
      POD_BACKOFF_REASONS.has(String(c?.state?.waiting?.reason ?? '').toLowerCase())
    ) ??
    statuses.find((c) => c?.ready === false) ??
    statuses[0] ??
    null;
  const terminated = stuck?.state?.terminated ?? stuck?.lastState?.terminated ?? null;
  const waiting = stuck?.state?.waiting ?? null;
  return {
    pod: String(pod?.metadata?.name ?? ''),
    container: stuck?.name ?? null,
    reason: String(waiting?.reason ?? terminated?.reason ?? 'NotReady'),
    message: waiting?.message ?? terminated?.message ?? null,
    exitCode: typeof terminated?.exitCode === 'number' ? terminated.exitCode : null,
    restarts
  };
}

function lastTerminationReason(pod: FailingPod, pods: any[]): string | null {
  const manifest = pods.find((p) => p?.metadata?.name === pod.pod);
  const cs = (manifest?.status?.containerStatuses ?? []).find(
    (c: any) => c?.name === pod.container
  );
  return cs?.lastState?.terminated?.reason ?? cs?.state?.terminated?.reason ?? null;
}

export function failureHint(failing: FailingPod[], pods: any[], serving: number): string {
  const first = failing[0];
  const reason = first.reason.toLowerCase();
  const termination = (lastTerminationReason(first, pods) ?? '').toLowerCase();
  const prefix =
    serving > 0
      ? `New pods are failing while ${serving} pod${serving === 1 ? '' : 's'} keep serving the previous version. `
      : '';
  if (termination === 'oomkilled' || reason === 'oomkilled') {
    return `${prefix}The container ran out of memory (OOMKilled). Raise the deployment's memory request or reduce the app's memory use.`;
  }
  if (
    reason === 'imagepullbackoff' ||
    reason === 'errimagepull' ||
    reason === 'errimagepullbackoff' ||
    reason === 'invalidimagename'
  ) {
    return `${prefix}The image couldn't be pulled. Check the image name and tag, and add registry credentials if the image is private.`;
  }
  if (reason === 'createcontainerconfigerror' || reason === 'createcontainererror') {
    return `${prefix}The container couldn't be created from its config, usually a missing secret, config map key or volume.`;
  }
  const exit = first.exitCode !== null ? ` (exit code ${first.exitCode})` : '';
  return `${prefix}The app keeps exiting${exit}. Read the log tail: common causes are a missing env var, a wrong start command, or a crash on boot.`;
}

function quotaFailure(manifest: any): { reason: string; sinceMs: number | null } | null {
  const condition = (manifest?.status?.conditions ?? []).find(
    (c: any) => c?.type === 'ReplicaFailure' && c?.status === 'True'
  );
  if (!condition || !isQuotaFailure(condition.message)) return null;
  return {
    reason: String(condition.message),
    sinceMs: toDate(condition.lastTransitionTime)?.getTime() ?? null
  };
}

function progressDeadlineExceeded(manifest: any): boolean {
  return (manifest?.status?.conditions ?? []).some(
    (c: any) =>
      c?.type === 'Progressing' && c?.status === 'False' && c?.reason === 'ProgressDeadlineExceeded'
  );
}

function verdict(
  phase: RolloutPhase,
  desired: number,
  ready: number,
  failing: FailingPod[],
  hint: string | null
): RolloutVerdict {
  return { phase, terminal: TERMINAL_PHASES.has(phase), desired, ready, failing, hint };
}

export function deriveRolloutPhase(s: RolloutState): RolloutVerdict {
  const d = s.deployment;
  const nowMs = s.now.getTime();
  const intentDesired = d.stopped ? 0 : Math.max(0, d.replicas);
  const livePods = s.pods.filter((p) => {
    const st = computePodStatus(p);
    return st !== 'terminating' && st !== 'succeeded';
  });
  const readyCount = livePods.filter((p) => computePodStatus(p) === 'ready').length;
  const buildStatus = (d.buildStatus ?? '').toLowerCase();

  if (s.activeBuildRun?.status === 'scheduled' && buildStatus !== 'building') {
    return verdict(
      'queued',
      intentDesired,
      readyCount,
      [],
      'The build is queued and starts when a build slot frees up.'
    );
  }
  if (buildStatus === 'pending' || buildStatus === 'queued') {
    return verdict(
      'queued',
      intentDesired,
      readyCount,
      [],
      'The build is queued and starts when a build slot frees up.'
    );
  }
  if (buildStatus === 'building' || s.activeBuildRun?.status === 'building') {
    if ((d.buildStep ?? '').toLowerCase() === 'deploying') {
      return verdict('deploying', intentDesired, readyCount, [], null);
    }
    return verdict('building', intentDesired, readyCount, [], null);
  }

  const failedAt = s.lastBuildFinishedAt ?? d.updatedAt;
  const staleFailure = !!s.pin && failedAt.getTime() < s.pin.since.getTime();
  if (buildStatus === 'failed' && !staleFailure) {
    if ((d.buildError ?? '').startsWith('Deploy failed:')) {
      return verdict(
        'unhealthy',
        intentDesired,
        readyCount,
        [],
        'The new release never became ready, so the previous release kept serving.'
      );
    }
    return verdict(
      'build_failed',
      intentDesired,
      readyCount,
      [],
      'The build failed. Fix the error in build.error and push again, or rebuild once the cause is fixed.'
    );
  }

  if (s.pin?.releaseStatus === 'failed') {
    return verdict(
      'unhealthy',
      intentDesired,
      readyCount,
      [],
      s.pin.releaseReason
        ? `This release never became ready: ${s.pin.releaseReason}`
        : 'This release never became ready, so the previous release kept serving.'
    );
  }

  if (intentDesired === 0) {
    return verdict(
      'stopped',
      0,
      readyCount,
      [],
      'The deployment is stopped (scaled to zero). Start or scale it to bring it back.'
    );
  }

  const manifest = s.workload?.manifest ?? null;
  const withinIntentGrace = nowMs - d.updatedAt.getTime() < INTENT_GRACE_MS;
  const specReplicas =
    typeof manifest?.spec?.replicas === 'number' ? (manifest.spec.replicas as number) : null;
  const replicasMatch = specReplicas === null || specReplicas === intentDesired;
  const desired = replicasMatch || withinIntentGrace ? intentDesired : (specReplicas ?? 0);

  const failing = livePods
    .map((p) => describeFailingPod(p))
    .filter((p): p is FailingPod => p !== null);
  if (failing.length > 0) {
    const serving = readyCount;
    return verdict(
      serving > 0 ? 'unhealthy' : 'crashing',
      desired,
      readyCount,
      failing,
      failureHint(failing, s.pods, serving)
    );
  }

  const blocked = readyCount < desired ? quotaFailure(manifest) : null;
  if (blocked) {
    const lasting = blocked.sinceMs !== null && nowMs - blocked.sinceMs >= QUOTA_PATIENCE_MS;
    return verdict(
      lasting ? 'unhealthy' : 'deploying',
      desired,
      readyCount,
      [],
      quotaHint(blocked.reason, readyCount)
    );
  }

  if (manifest && progressDeadlineExceeded(manifest)) {
    return verdict(
      'unhealthy',
      desired,
      readyCount,
      [],
      'The rollout stopped making progress before every pod became ready. Check that the app passes its health check on the configured port.'
    );
  }

  const templateImages: string[] = (manifest?.spec?.template?.spec?.containers ?? []).map(
    (c: any) => imageKey(c?.image)
  );
  const imageMatches =
    !manifest ||
    !d.image ||
    templateImages.length === 0 ||
    templateImages.includes(imageKey(d.image));
  const intentObserved = (replicasMatch && imageMatches) || !withinIntentGrace;

  let pinObserved = true;
  if (s.pin) {
    const sinceMs = s.pin.since.getTime();
    const graceOver = nowMs - sinceMs > PIN_GRACE_MS;
    const syncedAt = s.workload?.syncedAt ?? null;
    const restartedAt = toDate(
      manifest?.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']
    );
    const podAfter = livePods.some((p) => {
      const created = toDate(p?.metadata?.creationTimestamp);
      return !!created && created.getTime() >= sinceMs;
    });
    const seen =
      (!!syncedAt && syncedAt.getTime() >= sinceMs) ||
      (!!restartedAt && restartedAt.getTime() >= sinceMs) ||
      podAfter;
    const pinImageOk = !s.pin.image || !manifest || templateImages.includes(imageKey(s.pin.image));
    pinObserved = (seen || graceOver) && (pinImageOk || graceOver);
  }

  let rolledOut: boolean;
  if (manifest) {
    const generation = Number(manifest.metadata?.generation ?? 0);
    const observed = Number(manifest.status?.observedGeneration ?? 0);
    const updated = Number(manifest.status?.updatedReplicas ?? 0);
    const available = Number(manifest.status?.availableReplicas ?? 0);
    const total = Number(manifest.status?.replicas ?? 0);
    rolledOut =
      observed >= generation && updated >= desired && available >= desired && total <= desired;
  } else {
    rolledOut = readyCount >= desired && livePods.length <= desired;
  }

  if (pinObserved && intentObserved && rolledOut && readyCount >= desired) {
    return verdict('live', desired, readyCount, [], null);
  }

  const waitingOnHealth = livePods.some((p) => computePodStatus(p) === 'starting');
  const unscheduled = livePods.some((p) => computePodStatus(p) === 'pending');
  const hint = unscheduled
    ? 'Some pods are waiting to be scheduled onto a node.'
    : waitingOnHealth
      ? "Pods are running but haven't passed their health check yet."
      : null;
  return verdict('deploying', desired, readyCount, [], hint);
}
