import type * as k8s from '@kubernetes/client-node';

export function latestTermination(
  containerStatuses: k8s.V1ContainerStatus[],
): { reason: string | null; exitCode: number | null; finishedAt: Date | null } | null {
  let best: { reason: string | null; exitCode: number | null; finishedAt: Date | null } | null =
    null;
  for (const cs of containerStatuses) {
    const t = cs.state?.terminated ?? cs.lastState?.terminated;
    if (!t) continue;
    const finishedAt = t.finishedAt ? new Date(t.finishedAt) : null;
    if (best && best.finishedAt && finishedAt && finishedAt <= best.finishedAt) continue;
    best = {
      reason: t.reason ?? null,
      exitCode: t.exitCode ?? null,
      finishedAt,
    };
  }
  return best;
}

const BACKOFF_REASONS = new Set([
  'crashloopbackoff',
  'imagepullbackoff',
  'errimagepull',
  'createcontainererror',
]);

// Mirrors k8s-workload.service getDeploymentPods status derivation so the
// stored `pods` table matches what the live pod path reports.
export function computePodStatus(pod: k8s.V1Pod): string {
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const phase = pod.status?.phase?.toLowerCase() || 'pending';
  const conditions = pod.status?.conditions ?? [];
  const isScheduled = conditions.some((c) => c.type === 'PodScheduled' && c.status === 'True');
  const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const allContainersReady =
    containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);

  let status = phase;
  if (phase === 'running') {
    if (isReady && allContainersReady) status = 'ready';
    else if (isScheduled) status = 'scheduled';
    else status = 'pending';
  } else if (phase === 'pending' && isScheduled) {
    status = 'scheduled';
  }

  for (const c of containerStatuses) {
    const reason = c?.state?.waiting?.reason;
    if (reason && BACKOFF_REASONS.has(String(reason).toLowerCase())) {
      status = 'crashing';
      break;
    }
  }

  return status;
}
