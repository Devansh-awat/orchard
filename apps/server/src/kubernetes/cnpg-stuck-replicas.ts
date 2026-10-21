export interface StuckReplica {
  instance: string;
  pvcs: string[];
  jobs: string[];
  reason: 'join_failed' | 'surplus';
}

interface Meta {
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string | Date;
}

export interface StuckReplicaInput {
  cluster: {
    spec?: { instances?: number };
    status?: { currentPrimary?: string; targetPrimary?: string; readyInstances?: number };
  };
  pvcs: Array<{ metadata?: Meta }>;
  jobs: Array<{
    metadata?: Meta;
    status?: { active?: number; conditions?: Array<{ type?: string; status?: string }> };
  }>;
  pods: Array<{ metadata?: Meta }>;
  now: number;
}

export const SURPLUS_GRACE_MS = 15 * 60_000;

export function stuckReplicas(input: StuckReplicaInput): StuckReplica[] {
  const primaries = new Set(
    [input.cluster.status?.currentPrimary, input.cluster.status?.targetPrimary].filter(Boolean)
  );
  const initializing = new Map<string, { names: string[]; oldest: number }>();
  for (const pvc of input.pvcs) {
    const meta = pvc.metadata ?? {};
    if (meta.annotations?.['cnpg.io/pvcStatus'] !== 'initializing') continue;
    const instance = meta.labels?.['cnpg.io/instanceName'];
    if (!instance || !meta.name || primaries.has(instance)) continue;
    const created = meta.creationTimestamp ? new Date(meta.creationTimestamp).getTime() : NaN;
    const entry = initializing.get(instance) ?? { names: [], oldest: Number.POSITIVE_INFINITY };
    entry.names.push(meta.name);
    if (Number.isFinite(created)) entry.oldest = Math.min(entry.oldest, created);
    initializing.set(instance, entry);
  }

  const podNames = new Set(input.pods.map((p) => p.metadata?.name).filter(Boolean));
  const ready = input.cluster.status?.readyInstances ?? 0;
  const wanted = input.cluster.spec?.instances ?? 1;
  const out: StuckReplica[] = [];

  for (const [instance, pvcs] of initializing) {
    const jobs = input.jobs.filter((job) => {
      const name = job.metadata?.name ?? '';
      return (
        job.metadata?.labels?.['cnpg.io/instanceName'] === instance ||
        name.startsWith(`${instance}-`)
      );
    });
    const joins = jobs.filter((job) => (job.metadata?.name ?? '').endsWith('-join'));
    if (jobs.some((job) => (job.status?.active ?? 0) > 0)) continue;
    const failedJoins = joins.filter((job) =>
      (job.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True')
    );
    if (failedJoins.length > 0 && failedJoins.length === jobs.length) {
      out.push({
        instance,
        pvcs: pvcs.names,
        jobs: failedJoins.map((job) => job.metadata!.name!),
        reason: 'join_failed'
      });
      continue;
    }
    if (
      jobs.length === 0 &&
      !podNames.has(instance) &&
      ready >= wanted &&
      input.now - pvcs.oldest > SURPLUS_GRACE_MS
    ) {
      out.push({ instance, pvcs: pvcs.names, jobs: [], reason: 'surplus' });
    }
  }
  return out;
}
