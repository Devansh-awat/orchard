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
 * status Orchard shows. Every read path goes through this: the mirror, the
 * legacy informer and the live workload lookups, so the stored `pods` rows and
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
  if (podBackoffReason(pod.status?.initContainerStatuses)) return 'crashing';

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

export type ContainerFact = {
  name: string;
  init: boolean;
  image: string | null;
  ready: boolean;
  restartCount: number;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  reason: string | null;
  message: string | null;
  startedAt: string | null;
  lastTermination: {
    reason: string | null;
    exitCode: number | null;
    finishedAt: string | null;
  } | null;
};

export type PodFacts = {
  phase: string | null;
  reason: string | null;
  slot: string | null;
  disruption: string | null;
  probes: { liveness: boolean; readiness: boolean; startup: boolean };
  deletingAt: string | null;
  graceSeconds: number | null;
  scheduled: boolean;
  unschedulableSince: string | null;
  schedulingMessage: string | null;
  readySince: string | null;
  notReadySince: string | null;
  containers: ContainerFact[];
};

const iso = (value: Date | string | undefined | null) =>
  value ? new Date(value).toISOString() : null;

function containerFact(
  status: k8s.V1ContainerStatus | undefined,
  spec: k8s.V1Container,
  init: boolean
): ContainerFact {
  const state = status?.state;
  const kind: ContainerFact['state'] = state?.running
    ? 'running'
    : state?.waiting
      ? 'waiting'
      : state?.terminated
        ? 'terminated'
        : 'unknown';
  const term = state?.terminated ?? status?.lastState?.terminated;
  const message = state?.waiting?.message ?? state?.terminated?.message ?? null;
  return {
    name: spec.name,
    init,
    image: status?.image ?? spec.image ?? null,
    ready: status?.ready ?? false,
    restartCount: status?.restartCount ?? 0,
    state: kind,
    reason: state?.waiting?.reason ?? state?.terminated?.reason ?? null,
    message: message ? message.slice(0, 240) : null,
    startedAt: iso(state?.running?.startedAt ?? state?.terminated?.startedAt),
    lastTermination: term
      ? {
          reason: term.reason ?? null,
          exitCode: term.exitCode ?? null,
          finishedAt: iso(term.finishedAt)
        }
      : null
  };
}

export function podFacts(pod: k8s.V1Pod): PodFacts {
  const conditions = pod.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === 'Ready');
  const scheduled = conditions.find((c) => c.type === 'PodScheduled');
  const byName = (list: k8s.V1ContainerStatus[] | undefined) =>
    new Map((list ?? []).map((c) => [c.name, c]));
  const initStatus = byName(pod.status?.initContainerStatuses);
  const mainStatus = byName(pod.status?.containerStatuses);
  const main = pod.spec?.containers?.[0];
  const disruption = conditions.find((c) => c.type === 'DisruptionTarget' && c.status === 'True');
  return {
    phase: pod.status?.phase ?? null,
    reason: pod.status?.reason ?? null,
    slot: pod.metadata?.labels?.['orchard.my/slot'] ?? null,
    disruption: disruption?.reason ?? null,
    probes: {
      liveness: !!main?.livenessProbe,
      readiness: !!main?.readinessProbe,
      startup: !!main?.startupProbe
    },
    deletingAt: iso(pod.metadata?.deletionTimestamp),
    graceSeconds:
      pod.metadata?.deletionGracePeriodSeconds ?? pod.spec?.terminationGracePeriodSeconds ?? null,
    scheduled: scheduled?.status === 'True',
    unschedulableSince:
      scheduled?.status === 'False' && scheduled.reason === 'Unschedulable'
        ? iso(scheduled.lastTransitionTime)
        : null,
    schedulingMessage:
      scheduled?.status === 'False' ? ((scheduled.message ?? null)?.slice(0, 240) ?? null) : null,
    readySince: ready?.status === 'True' ? iso(ready.lastTransitionTime) : null,
    notReadySince: ready?.status !== 'True' ? iso(ready?.lastTransitionTime) : null,
    containers: [
      ...(pod.spec?.initContainers ?? []).map((c) =>
        containerFact(initStatus.get(c.name), c, true)
      ),
      ...(pod.spec?.containers ?? []).map((c) => containerFact(mainStatus.get(c.name), c, false))
    ]
  };
}

export function podRecord(pod: k8s.V1Pod) {
  const facts = podFacts(pod);
  const restartCount = facts.containers
    .filter((c) => !c.init)
    .reduce((sum, c) => sum + c.restartCount, 0);
  const createdAt = iso(pod.metadata?.creationTimestamp);
  return {
    id: pod.metadata?.name,
    name: pod.metadata?.name,
    status: computePodStatus(pod),
    ip: pod.status?.podIP ?? null,
    podIp: pod.status?.podIP ?? null,
    nodeName: pod.spec?.nodeName ?? null,
    revision: pod.metadata?.labels?.['pod-template-hash'] ?? null,
    restartCount,
    startTime: iso(pod.status?.startTime) ?? createdAt,
    createdAt,
    ...facts
  };
}
