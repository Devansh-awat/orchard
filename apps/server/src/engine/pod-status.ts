import type * as k8s from '@kubernetes/client-node';

export function latestTermination(
  containerStatuses: k8s.V1ContainerStatus[]
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
      finishedAt
    };
  }
  return best;
}

// Waiting reasons that mean the container will not come up on its own. A
// missing secret key (CreateContainerConfigError) or a typo'd tag
// (InvalidImageName) is just as stuck as a crash loop, so all of them read as
// `crashing` rather than as a benign progress state.
export const POD_BACKOFF_REASONS = new Set([
  'crashloopbackoff',
  'imagepullbackoff',
  'errimagepull',
  'errimagepullbackoff',
  'createcontainererror',
  'createcontainerconfigerror',
  'runcontainererror',
  'invalidimagename'
]);

export function podBackoffReason(
  containerStatuses: k8s.V1ContainerStatus[] | undefined
): string | null {
  for (const c of containerStatuses ?? []) {
    const reason = c?.state?.waiting?.reason;
    if (reason && POD_BACKOFF_REASONS.has(String(reason).toLowerCase())) return reason;
  }
  return null;
}

/**
 * The one place a pod's phase, conditions and container states turn into the
 * status Orchard shows. Every read path goes through this — the mirror, the
 * legacy informer and the live workload lookups — so the stored `pods` rows and
 * a live cluster query can never disagree.
 *
 *   terminating  the pod is being deleted
 *   crashing     a container is stuck in a backoff reason
 *   ready        running and passing readiness
 *   starting     running, readiness not satisfied yet
 *   scheduled    assigned to a node, containers not up
 *   pending      not yet scheduled
 */
export function computePodStatus(pod: k8s.V1Pod): string {
  if (pod.metadata?.deletionTimestamp) return 'terminating';

  const containerStatuses = pod.status?.containerStatuses ?? [];
  if (podBackoffReason(containerStatuses)) return 'crashing';

  const phase = pod.status?.phase?.toLowerCase() || 'pending';
  const conditions = pod.status?.conditions ?? [];
  const isScheduled = conditions.some((c) => c.type === 'PodScheduled' && c.status === 'True');
  const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const allContainersReady =
    containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);

  if (phase === 'running') {
    // A running pod already has a node, so `scheduled` would be telling the
    // user something they stopped needing to know. What is actually happening
    // is that the container is up and its health check has not passed yet.
    return isReady && allContainersReady ? 'ready' : 'starting';
  }
  if (phase === 'pending') return isScheduled ? 'scheduled' : 'pending';
  return phase;
}
