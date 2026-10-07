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
  spec?: { backup?: { barmanObjectStore?: unknown } | null };
  status?: {
    lastSuccessfulBackup?: string;
    conditions?: { type?: string; status?: string }[];
  };
}

interface BackupLike {
  metadata?: { namespace?: string };
  spec?: { cluster?: { name?: string } };
  status?: { phase?: string } | null;
}

const TERMINAL = new Set(['completed', 'failed']);

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

  const gauges: FleetGauge[] = [];
  for (const c of clusters) {
    const namespace = c.metadata?.namespace;
    const name = c.metadata?.name;
    if (!namespace || !name) continue;
    if (!c.spec?.backup?.barmanObjectStore) continue;
    if (c.metadata?.annotations?.['cnpg.io/hibernation'] === 'on') continue;
    const tags = [`kube_namespace:${namespace}`, `cnpg_cluster:${name}`];
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
      Date.parse(c.status?.lastSuccessfulBackup ?? '') ||
      Date.parse(c.metadata?.creationTimestamp ?? '');
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
