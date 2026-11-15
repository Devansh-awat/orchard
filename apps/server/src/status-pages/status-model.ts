export type ComponentKind = 'deployment' | 'database';

export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'maintenance' | 'unknown';

export type OverallStatus = 'operational' | 'degraded' | 'down';

export interface ComponentRef {
  id: string;
  kind: ComponentKind;
  resourceId: string;
  name: string;
}

export interface DeploymentFacts {
  status: string;
  stopped: boolean;
  replicas: number;
  workload: { specReplicas: number | null; readyReplicas: number } | null;
  crashingSince: Date | null;
  firingAlerts: number;
}

export interface DatabaseFacts {
  status: string;
  crashingSince: Date | null;
}

export const MAX_COMPONENTS = 40;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
export const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const SEVERITY: Record<ComponentStatus, number> = {
  operational: 0,
  unknown: 1,
  maintenance: 2,
  degraded: 3,
  down: 4
};

export function deploymentStatus(f: DeploymentFacts): {
  status: ComponentStatus;
  detail: string | null;
} {
  if (f.stopped || f.status === 'stopped') return { status: 'maintenance', detail: 'Stopped' };
  if (f.status === 'deleting') return { status: 'maintenance', detail: 'Being removed' };
  const wanted = f.workload?.specReplicas ?? f.replicas;
  const ready = f.workload?.readyReplicas ?? null;
  if (f.crashingSince) {
    return ready === 0 || ready === null
      ? { status: 'down', detail: 'Crashing' }
      : { status: 'degraded', detail: 'Some replicas are crashing' };
  }
  if (!f.workload) {
    return f.status === 'running'
      ? { status: 'unknown', detail: 'No data yet' }
      : { status: 'unknown', detail: null };
  }
  if (wanted > 0 && ready === 0) return { status: 'down', detail: 'No replicas ready' };
  if (wanted > 0 && ready !== null && ready < wanted) {
    return { status: 'degraded', detail: `${ready} of ${wanted} replicas ready` };
  }
  if (f.firingAlerts > 0) {
    return {
      status: 'degraded',
      detail: f.firingAlerts === 1 ? 'An alert is firing' : `${f.firingAlerts} alerts are firing`
    };
  }
  return { status: 'operational', detail: null };
}

export function databaseStatus(f: DatabaseFacts): {
  status: ComponentStatus;
  detail: string | null;
} {
  if (f.crashingSince) return { status: 'down', detail: 'Restarting repeatedly' };
  switch (f.status) {
    case 'ready':
    case 'running':
      return { status: 'operational', detail: null };
    case 'stopped':
      return { status: 'maintenance', detail: 'Stopped' };
    case 'restoring':
    case 'creating':
    case 'starting':
    case 'scaling':
    case 'updating':
      return { status: 'degraded', detail: f.status.charAt(0).toUpperCase() + f.status.slice(1) };
    case 'error':
    case 'failed':
    case 'crashing':
      return { status: 'down', detail: 'Unavailable' };
    default:
      return { status: 'unknown', detail: null };
  }
}

export function overallStatus(statuses: readonly ComponentStatus[]): OverallStatus {
  let worst: ComponentStatus = 'operational';
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  if (worst === 'down') return 'down';
  if (worst === 'degraded') return 'degraded';
  return 'operational';
}

export interface Transition {
  podName: string;
  toStatus: string;
  at: Date;
}

export interface Incident {
  startedAt: Date;
  endedAt: Date | null;
}

const INCIDENT_MERGE_MS = 5 * 60 * 1000;

/**
 * Past outages, rebuilt from the pod transitions the mirror already keeps.
 * A crash opens an incident; the next ready pod of the same app closes it;
 * gaps shorter than five minutes are one incident, since a pod that is
 * recreated three times in a row is one story, not three. `ongoingSince`
 * comes from the live crash state so the current incident is never told by
 * the transition log alone, which can lag it.
 */
export function incidentsFromTransitions(
  transitions: readonly Transition[],
  ongoingSince: Date | null,
  now: Date
): Incident[] {
  const sorted = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const incidents: Incident[] = [];
  let open: Incident | null = null;
  for (const t of sorted) {
    if (t.toStatus === 'crashing' || t.toStatus === 'failed') {
      if (open && open.endedAt === null) continue;
      const last = incidents[incidents.length - 1];
      if (last && last.endedAt && t.at.getTime() - last.endedAt.getTime() < INCIDENT_MERGE_MS) {
        last.endedAt = null;
        open = last;
        continue;
      }
      open = { startedAt: t.at, endedAt: null };
      incidents.push(open);
    } else if (t.toStatus === 'ready' && open && open.endedAt === null) {
      open.endedAt = t.at;
      open = null;
    }
  }
  if (ongoingSince) {
    const last = incidents[incidents.length - 1];
    if (last && last.endedAt === null) {
      if (ongoingSince.getTime() < last.startedAt.getTime()) last.startedAt = ongoingSince;
    } else if (
      last &&
      last.endedAt &&
      ongoingSince.getTime() - last.endedAt.getTime() < INCIDENT_MERGE_MS
    ) {
      last.endedAt = null;
    } else {
      incidents.push({ startedAt: ongoingSince, endedAt: null });
    }
  } else if (open && open.endedAt === null) {
    open.endedAt = now;
  }
  return incidents;
}

export interface DayBar {
  day: string;
  status: 'operational' | 'degraded' | 'down' | 'none';
  downtimeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function uptimeDays(incidents: readonly Incident[], now: Date, days = 30): DayBar[] {
  const bars: DayBar[] = [];
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(start.getTime() - i * DAY_MS);
    const dayEnd = new Date(Math.min(dayStart.getTime() + DAY_MS, now.getTime()));
    let downtime = 0;
    for (const inc of incidents) {
      const s = Math.max(inc.startedAt.getTime(), dayStart.getTime());
      const e = Math.min((inc.endedAt ?? now).getTime(), dayEnd.getTime());
      if (e > s) downtime += e - s;
    }
    const span = dayEnd.getTime() - dayStart.getTime();
    bars.push({
      day: dayKey(dayStart),
      downtimeMs: downtime,
      status:
        downtime === 0 ? 'operational' : downtime / Math.max(span, 1) > 0.05 ? 'down' : 'degraded'
    });
  }
  return bars;
}

export function uptimePercent(bars: readonly DayBar[], now: Date): number {
  if (bars.length === 0) return 100;
  const first = new Date(`${bars[0].day}T00:00:00.000Z`).getTime();
  const total = Math.max(now.getTime() - first, 1);
  const down = bars.reduce((sum, b) => sum + b.downtimeMs, 0);
  return Math.max(0, Math.min(100, Math.round((1 - down / total) * 10000) / 100));
}

export function normalizeComponents(raw: unknown): ComponentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ComponentRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const kind = c.kind === 'database' ? 'database' : c.kind === 'deployment' ? 'deployment' : null;
    const resourceId = typeof c.resourceId === 'string' ? c.resourceId : null;
    if (!kind || !resourceId) continue;
    const key = `${kind}:${resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : '';
    out.push({ id: typeof c.id === 'string' && c.id ? c.id : key, kind, resourceId, name });
    if (out.length >= MAX_COMPONENTS) break;
  }
  return out;
}
