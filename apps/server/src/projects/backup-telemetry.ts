import { clusterArchivesWithPlugin } from '../kubernetes/cnpg-recovery';

export interface FleetGauge {
  metric: string;
  value: number;
  tags: string[];
}

interface ClusterLike {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    instances?: number;
    backup?: { barmanObjectStore?: unknown } | null;
    plugins?: unknown[];
  };
  status?: {
    readyInstances?: number;
    firstRecoverabilityPoint?: string;
    lastSuccessfulBackup?: string;
    conditions?: { type?: string; status?: string }[];
  };
}

interface BackupLike {
  metadata?: { namespace?: string };
  spec?: { cluster?: { name?: string } };
  status?: { phase?: string; stoppedAt?: string } | null;
}

const TERMINAL = new Set(['completed', 'failed']);

const SETTLE_MS = 60 * 60 * 1000;

export function backupFleetGauges(
  clusters: ClusterLike[],
  backups: BackupLike[],
  now = Date.now()
): FleetGauge[] {
  const waiting = new Map<string, number>();
  for (const b of backups) {
    if (TERMINAL.has(b.status?.phase ?? '')) continue;
    const key = `${b.metadata?.namespace}/${b.spec?.cluster?.name}`;
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }

  const lastCompleted = new Map<string, number>();
  for (const b of backups) {
    if (b.status?.phase !== 'completed') continue;
    const at = Date.parse(b.status?.stoppedAt ?? '');
    if (!at) continue;
    const key = `${b.metadata?.namespace}/${b.spec?.cluster?.name}`;
    lastCompleted.set(key, Math.max(lastCompleted.get(key) ?? 0, at));
  }

  const gauges: FleetGauge[] = [];
  for (const c of clusters) {
    const namespace = c.metadata?.namespace;
    const name = c.metadata?.name;
    if (!namespace || !name) continue;
    if (c.metadata?.annotations?.['cnpg.io/hibernation'] === 'on') continue;
    const tags = [`kube_namespace:${namespace}`, `cnpg_cluster:${name}`];
    const ageMs = now - (Date.parse(c.metadata?.creationTimestamp ?? '') || now);
    const settled = ageMs > SETTLE_MS;
    gauges.push({
      metric: 'orchard.cnpg.down',
      value: settled && (c.status?.readyInstances ?? 0) === 0 ? 1 : 0,
      tags
    });
    const key = `${namespace}/${name}`;
    const archives =
      Boolean(c.spec?.backup?.barmanObjectStore) || clusterArchivesWithPlugin(c.spec);
    const recoverable = Boolean(c.status?.firstRecoverabilityPoint) || lastCompleted.has(key);
    gauges.push({
      metric: 'orchard.cnpg.unprotected',
      value: settled && (!archives || !recoverable) ? 1 : 0,
      tags
    });
    if (!archives) continue;
    gauges.push({
      metric: 'orchard.cnpg.backups_waiting',
      value: waiting.get(`${namespace}/${name}`) ?? 0,
      tags
    });
    const archiving = c.status?.conditions?.find((x) => x.type === 'ContinuousArchiving');
    gauges.push({
      metric: 'orchard.cnpg.archiving_failing',
      value: archiving?.status === 'False' ? 1 : 0,
      tags
    });
    const since =
      Math.max(
        Date.parse(c.status?.lastSuccessfulBackup ?? '') || 0,
        lastCompleted.get(key) ?? 0
      ) || Date.parse(c.metadata?.creationTimestamp ?? '');
    if (since) {
      gauges.push({
        metric: 'orchard.cnpg.hours_since_backup',
        value: Math.max(0, (now - since) / 3_600_000),
        tags
      });
    }
  }
  return gauges;
}
