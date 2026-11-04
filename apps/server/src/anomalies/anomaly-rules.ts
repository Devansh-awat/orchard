export type AnomalySeverity = 'critical' | 'error' | 'warning';

export type AnomalyKind =
  | 'oom'
  | 'crashloop'
  | 'rollback'
  | 'apply_failed'
  | 'build_failed'
  | 'alert'
  | 'error_spike'
  | 'under_replicated'
  | 'db_crashing'
  | 'db_oom';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  resource: { kind: 'deployment' | 'database'; id: string; name: string };
  title: string;
  detail: string;
  since: string | null;
  href: string;
  action: { label: string; href: string } | null;
}

export interface PodFact {
  status: string;
  restartCount: number;
  lastTerminationReason: string | null;
  lastTerminatedAt: Date | null;
}

export interface DeploymentFacts {
  id: string;
  name: string;
  stopped: boolean;
  replicas: number;
  memoryBytes: number | null;
  crashingSince: Date | null;
  workload: { specReplicas: number | null; readyReplicas: number } | null;
  pods: PodFact[];
  alerts: { label: string; lastValue: number | null; firingSince: Date | null; unit: string }[];
  failedRelease: { reason: string | null; createdAt: Date } | null;
  applyError: string | null;
  buildStatus: string | null;
  buildError: string | null;
  errorGroups: { message: string; count: number; lastSeenAt: Date }[];
  errorTextVisible: boolean;
  href: string;
}

export interface DatabaseFacts {
  id: string;
  name: string;
  crashingSince: Date | null;
  pods: PodFact[];
  memoryBytes: number | null;
  href: string;
}

const RECENT_MS = 60 * 60 * 1000;
const RELEASE_RECENT_MS = 24 * 60 * 60 * 1000;
const ERROR_SPIKE_MIN = 10;
const SEVERITY_ORDER: Record<AnomalySeverity, number> = { critical: 0, error: 1, warning: 2 };

export function formatSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number(gib.toFixed(gib >= 10 ? 0 : 1))} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function recentOom(pods: PodFact[], now: number): { count: number; last: Date | null } {
  let count = 0;
  let last: Date | null = null;
  for (const p of pods) {
    if (p.lastTerminationReason !== 'OOMKilled') continue;
    const at = p.lastTerminatedAt;
    if (!at || now - at.getTime() > RECENT_MS) continue;
    count += Math.max(1, p.restartCount);
    if (!last || at > last) last = at;
  }
  return { count, last };
}

export function deploymentAnomalies(d: DeploymentFacts, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  const resource = { kind: 'deployment' as const, id: d.id, name: d.name };
  const oom = recentOom(d.pods, now);
  if (oom.count > 0) {
    const limit = formatSize(d.memoryBytes);
    out.push({
      id: `${d.id}:oom`,
      kind: 'oom',
      severity: 'critical',
      resource,
      title: 'ran out of memory',
      detail: `Killed ${plural(oom.count, 'time')} in the last hour${limit ? `, the limit is ${limit}` : ''}`,
      since: oom.last?.toISOString() ?? null,
      href: d.href,
      action: { label: 'Raise the limit', href: `${d.href}?tab=settings&s=resources` }
    });
  }
  const crashing = d.pods.some((p) => p.status === 'crashing') || !!d.crashingSince;
  if (crashing && oom.count === 0 && !d.stopped) {
    const reason = d.pods.find((p) => p.lastTerminationReason)?.lastTerminationReason;
    out.push({
      id: `${d.id}:crashloop`,
      kind: 'crashloop',
      severity: 'critical',
      resource,
      title: 'keeps crashing',
      detail: reason ? `Last exit: ${reason}` : 'Pods restart before they become ready',
      since: d.crashingSince?.toISOString() ?? null,
      href: d.href,
      action: { label: 'See why', href: `${d.href}?tab=observe&view=killed` }
    });
  }
  if (d.buildStatus === 'failed') {
    out.push({
      id: `${d.id}:build`,
      kind: 'build_failed',
      severity: 'error',
      resource,
      title: 'failed to build',
      detail:
        (d.errorTextVisible && d.buildError?.split('\n')[0].slice(0, 160)) ||
        "The last build didn't finish",
      since: null,
      href: d.href,
      action: { label: 'Build logs', href: `${d.href}?tab=deploys` }
    });
  }
  if (d.failedRelease && now - d.failedRelease.createdAt.getTime() < RELEASE_RECENT_MS) {
    out.push({
      id: `${d.id}:rollback`,
      kind: 'rollback',
      severity: 'error',
      resource,
      title: 'rolled back',
      detail: d.failedRelease.reason?.slice(0, 160) || 'The new release never became ready',
      since: d.failedRelease.createdAt.toISOString(),
      href: d.href,
      action: { label: 'Releases', href: `${d.href}?tab=deploys` }
    });
  }
  if (d.applyError) {
    out.push({
      id: `${d.id}:apply`,
      kind: 'apply_failed',
      severity: 'error',
      resource,
      title: 'has a change Kubernetes refused',
      detail:
        (d.errorTextVisible && d.applyError.split('\n')[0].slice(0, 160)) ||
        'Kubernetes rejected the last change',
      since: null,
      href: d.href,
      action: { label: 'Retry', href: `${d.href}?tab=settings` }
    });
  }
  for (const a of d.alerts) {
    out.push({
      id: `${d.id}:alert:${a.label}`,
      kind: 'alert',
      severity: 'warning',
      resource,
      title: a.label,
      detail:
        a.lastValue != null
          ? `Now ${Math.round(a.lastValue * 10) / 10}${a.unit}`
          : 'Over the threshold',
      since: a.firingSince?.toISOString() ?? null,
      href: d.href,
      action: { label: 'Alerts', href: `${d.href}?tab=settings&s=notifications` }
    });
  }
  const spike = d.errorGroups.filter(
    (g) => g.count >= ERROR_SPIKE_MIN && now - g.lastSeenAt.getTime() < RECENT_MS
  );
  if (spike.length > 0) {
    const total = spike.reduce((sum, g) => sum + g.count, 0);
    out.push({
      id: `${d.id}:errors`,
      kind: 'error_spike',
      severity: 'warning',
      resource,
      title: 'is logging errors',
      detail: d.errorTextVisible
        ? `${plural(total, 'error')} in the last hour, most often: ${spike[0].message.slice(0, 100)}`
        : `${plural(total, 'error')} in the last hour`,
      since: spike[0].lastSeenAt.toISOString(),
      href: d.href,
      action: { label: 'Errors', href: `${d.href}?tab=observe&view=errors` }
    });
  }
  const spec = d.workload?.specReplicas ?? null;
  const ready = d.workload?.readyReplicas ?? null;
  if (!d.stopped && !crashing && spec != null && ready != null && spec > 0 && ready < spec) {
    out.push({
      id: `${d.id}:replicas`,
      kind: 'under_replicated',
      severity: ready === 0 ? 'error' : 'warning',
      resource,
      title: ready === 0 ? 'has no ready replicas' : 'is short on replicas',
      detail: `${ready} of ${spec} ready`,
      since: null,
      href: d.href,
      action: { label: 'Pods', href: `${d.href}?tab=observe&view=logs` }
    });
  }
  return out;
}

export function databaseAnomalies(db: DatabaseFacts, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  const resource = { kind: 'database' as const, id: db.id, name: db.name };
  const oom = recentOom(db.pods, now);
  if (oom.count > 0) {
    const limit = formatSize(db.memoryBytes);
    out.push({
      id: `${db.id}:oom`,
      kind: 'db_oom',
      severity: 'critical',
      resource,
      title: 'ran out of memory',
      detail: `Postgres was killed ${plural(oom.count, 'time')} in the last hour${limit ? `, the limit is ${limit}` : ''}`,
      since: oom.last?.toISOString() ?? null,
      href: db.href,
      action: { label: 'Raise the limit', href: `${db.href}?tab=resources` }
    });
  }
  const crashing = db.pods.some((p) => p.status === 'crashing') || !!db.crashingSince;
  if (crashing && oom.count === 0) {
    const reason = db.pods.find((p) => p.lastTerminationReason)?.lastTerminationReason;
    out.push({
      id: `${db.id}:crash`,
      kind: 'db_crashing',
      severity: 'critical',
      resource,
      title: 'keeps restarting',
      detail: reason ? `Last exit: ${reason}` : 'Postgres restarts before it is ready',
      since: db.crashingSince?.toISOString() ?? null,
      href: db.href,
      action: { label: 'See why', href: `${db.href}?tab=terminal` }
    });
  }
  return out;
}

export function rankAnomalies(items: Anomaly[]): Anomaly[] {
  return [...items].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const at = a.since ? Date.parse(a.since) : 0;
    const bt = b.since ? Date.parse(b.since) : 0;
    return bt - at;
  });
}
