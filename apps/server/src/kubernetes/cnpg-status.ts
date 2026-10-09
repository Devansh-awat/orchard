import { volumeFraction } from './db-stats';

export interface MirroredDbPod {
  status: string;
  restartCount: number;
  ready: boolean | null;
  lastTerminationReason: string | null;
  lastExitCode: number | null;
  lastTerminatedAt: Date | null;
  updatedAt: Date;
  runningSince?: Date | null;
  waitingReason?: string | null;
}

export const WRITE_GUARD_ANNOTATION = 'orchard.io/write-guard';

export interface ClusterSnapshot {
  exists: boolean;
  writeGuard: boolean;
  phase: string;
  instances: number;
  readyInstances: number;
  currentPrimary: string | null;
  hibernated: boolean;
  conditions: unknown[];
  firstRecoverabilityPoint: string | null;
  lastSuccessfulBackup: string | null;
  danglingPVC: string[];
  unusablePVC: string[];
}

export interface DbStats {
  sizeBytes: bigint | number | null;
  connections: number | null;
  statsAt: Date | null;
  volumeUsedBytes?: bigint | number | null;
  volumeCapacityBytes?: bigint | number | null;
  walPendingSegments?: number | null;
}

export function volumeUsage(stats: DbStats) {
  const fraction = volumeFraction(stats);
  if (fraction == null) return null;
  return {
    usedBytes: Number(stats.volumeUsedBytes),
    capacityBytes: Number(stats.volumeCapacityBytes),
    used: formatDbSize(stats.volumeUsedBytes),
    capacity: formatDbSize(stats.volumeCapacityBytes),
    percent: Math.round(fraction * 100)
  };
}

const STALE_TERMINATION_MS = 10 * 60 * 1000;

export function clusterSnapshot(cluster: any): ClusterSnapshot {
  const status = cluster?.status ?? {};
  const instances: number = status.instances || cluster?.spec?.instances || 1;
  return {
    exists: true,
    phase: status.phase || 'Unknown',
    instances,
    readyInstances: status.readyInstances || 0,
    currentPrimary: status.currentPrimary ?? null,
    hibernated: cluster?.metadata?.annotations?.['cnpg.io/hibernation'] === 'on',
    writeGuard: cluster?.metadata?.annotations?.[WRITE_GUARD_ANNOTATION] === 'storage',
    conditions: status.conditions || [],
    firstRecoverabilityPoint: status.firstRecoverabilityPoint || null,
    lastSuccessfulBackup: status.lastSuccessfulBackup || null,
    danglingPVC: status.danglingPVC || [],
    unusablePVC: status.unusablePVC || []
  };
}

export function formatDbSize(bytes: bigint | number | null | undefined): string | undefined {
  if (bytes == null) return undefined;
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  if (i < 3) return `${Math.round(n)} ${units[i]}`;
  return `${Number(n.toFixed(1))} ${units[i]}`;
}

export function foldPods(pods: MirroredDbPod[], now = Date.now()) {
  let restartCount = 0;
  let lastTerminationReason: string | undefined;
  let lastTerminationExitCode: number | undefined;
  let lastTerminationAt: string | undefined;
  let currentWaitingReason: string | undefined;
  let currentRunningSinceMs: number | undefined;
  let currentReady = false;
  for (const p of pods) {
    restartCount += p.restartCount ?? 0;
    if (p.lastTerminationReason) {
      const at = p.lastTerminatedAt ? p.lastTerminatedAt.toISOString() : undefined;
      if (!lastTerminationAt || (at && at > lastTerminationAt)) {
        lastTerminationReason = p.lastTerminationReason;
        lastTerminationExitCode = p.lastExitCode ?? undefined;
        lastTerminationAt = at;
      }
    }
    if (p.waitingReason) currentWaitingReason = p.waitingReason;
    else if (p.status === 'crashing') currentWaitingReason = 'CrashLoopBackOff';
    if (p.ready) {
      currentReady = true;
      const t = (p.runningSince ?? p.lastTerminatedAt ?? p.updatedAt).getTime();
      if (currentRunningSinceMs === undefined || t > currentRunningSinceMs) {
        currentRunningSinceMs = t;
      }
    }
  }
  const runningCleanlyForMs =
    currentReady && currentRunningSinceMs ? now - currentRunningSinceMs : 0;
  const terminationIsStale = runningCleanlyForMs > STALE_TERMINATION_MS;
  let message: string | undefined;
  if (currentWaitingReason) message = currentWaitingReason;
  else if (lastTerminationReason && lastTerminationReason !== 'Completed' && !terminationIsStale) {
    message = lastTerminationReason;
  }
  return {
    restartCount,
    message,
    lastTerminationReason,
    lastTerminationExitCode,
    lastTerminationAt
  };
}

export function buildCnpgLiveStatus(
  cluster: ClusterSnapshot,
  pods: MirroredDbPod[],
  stats: DbStats,
  now = Date.now()
) {
  if (!cluster.exists) return { exists: false };
  if (cluster.hibernated) {
    return {
      exists: true,
      ready: false,
      phase: 'hibernated',
      replicas: 0,
      readyReplicas: 0,
      message: 'Database is stopped'
    };
  }
  const folded = foldPods(pods, now);
  const ready = cluster.readyInstances >= cluster.instances && cluster.readyInstances > 0;
  const archivingCond: any = cluster.conditions.find((c: any) => c?.type === 'ContinuousArchiving');
  return {
    exists: true,
    phase: cluster.phase,
    ready,
    readyReplicas: cluster.readyInstances,
    replicas: cluster.instances,
    currentPrimary: cluster.currentPrimary ?? undefined,
    size: formatDbSize(stats.sizeBytes),
    volume: volumeUsage(stats),
    walPendingSegments: stats.walPendingSegments ?? undefined,
    connections: stats.connections ?? undefined,
    statsAt: stats.statsAt ? stats.statsAt.toISOString() : undefined,
    conditions: cluster.conditions,
    archiving: archivingCond
      ? {
          ok: archivingCond.status === 'True',
          message: archivingCond.message || null,
          since: archivingCond.lastTransitionTime || null
        }
      : null,
    firstRecoverabilityPoint: cluster.firstRecoverabilityPoint,
    lastSuccessfulBackup: cluster.lastSuccessfulBackup,
    danglingPVC: cluster.danglingPVC,
    unusablePVC: cluster.unusablePVC,
    writeGuard: cluster.writeGuard,
    ...folded
  };
}
