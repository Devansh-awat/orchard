import type { IngressQueries } from '../metrics/ingress';
import { deploymentPodRegex } from '../metrics/pod-selector';
import { escapeLabel } from '../metrics/victoria-metrics.service';

export type MetricId =
  | 'cpu_percent'
  | 'memory_percent'
  | 'request_rate'
  | 'error_rate'
  | 'latency_avg_ms'
  | 'latency_max_ms'
  | 'cpu_throttled_percent'
  | 'memory_forecast_hours';

export type Comparator = 'gt' | 'lt';

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: '%' | 'req/s' | 'ms' | 'h';
  comparators: Comparator[];
  needsIngress: boolean;
  needsLimits: boolean;
  requestRateGuard: boolean;
  defaultThreshold: number;
  defaultForSeconds: number;
  maxThreshold?: number;
}

export const METRIC_CATALOGUE: readonly MetricDef[] = [
  {
    id: 'cpu_percent',
    label: 'CPU',
    unit: '%',
    comparators: ['gt'],
    needsIngress: false,
    needsLimits: true,
    requestRateGuard: false,
    defaultThreshold: 85,
    defaultForSeconds: 300,
    maxThreshold: 1000
  },
  {
    id: 'memory_percent',
    label: 'Memory',
    unit: '%',
    comparators: ['gt'],
    needsIngress: false,
    needsLimits: true,
    requestRateGuard: false,
    defaultThreshold: 85,
    defaultForSeconds: 300,
    maxThreshold: 100
  },
  {
    id: 'request_rate',
    label: 'Requests',
    unit: 'req/s',
    comparators: ['gt', 'lt'],
    needsIngress: true,
    needsLimits: false,
    requestRateGuard: false,
    defaultThreshold: 100,
    defaultForSeconds: 300
  },
  {
    id: 'error_rate',
    label: '5xx rate',
    unit: '%',
    comparators: ['gt'],
    needsIngress: true,
    needsLimits: false,
    requestRateGuard: true,
    defaultThreshold: 5,
    defaultForSeconds: 300,
    maxThreshold: 100
  },
  {
    id: 'latency_avg_ms',
    label: 'Average latency',
    unit: 'ms',
    comparators: ['gt'],
    needsIngress: true,
    needsLimits: false,
    requestRateGuard: true,
    defaultThreshold: 500,
    defaultForSeconds: 300
  },
  {
    id: 'latency_max_ms',
    label: 'Max latency',
    unit: 'ms',
    comparators: ['gt'],
    needsIngress: true,
    needsLimits: false,
    requestRateGuard: true,
    defaultThreshold: 2000,
    defaultForSeconds: 300
  },
  {
    id: 'cpu_throttled_percent',
    label: 'CPU throttling',
    unit: '%',
    comparators: ['gt'],
    needsIngress: false,
    needsLimits: true,
    requestRateGuard: false,
    defaultThreshold: 25,
    defaultForSeconds: 600,
    maxThreshold: 100
  },
  {
    id: 'memory_forecast_hours',
    label: 'Hours until out of memory',
    unit: 'h',
    comparators: ['lt'],
    needsIngress: false,
    needsLimits: true,
    requestRateGuard: false,
    defaultThreshold: 6,
    defaultForSeconds: 1800,
    maxThreshold: 168
  }
];

export const METRIC_IDS: readonly MetricId[] = METRIC_CATALOGUE.map((m) => m.id);

export function metricDef(id: string): MetricDef | undefined {
  return METRIC_CATALOGUE.find((m) => m.id === id);
}

export const MIN_FOR_SECONDS = 60;
export const MAX_FOR_SECONDS = 24 * 60 * 60;
export const DEFAULT_MIN_REQUEST_RATE = 0.2;

export const RATE_WINDOW = '2m';

export interface MetricTarget {
  namespace: string;
  name: string;
  replicas: number;
  cpuLimitMilli: number | null;
  memoryLimitBytes: number | null;
  ingress: IngressQueries | null;
}

export type MetricQuery =
  | { kind: 'query'; promql: string }
  | { kind: 'inapplicable'; reason: string };

function podSelector(target: MetricTarget): string {
  return `namespace="${escapeLabel(target.namespace)}",pod=~"${deploymentPodRegex(target.name)}",container="",image=""`;
}

/**
 * The PromQL for one metric against one deployment, or the reason it cannot
 * be asked. A rule that cannot be evaluated for a target is skipped, never
 * read as zero: an app without an ingress has no 5xx rate, not a perfect one.
 */
export function buildMetricQuery(id: MetricId, target: MetricTarget): MetricQuery {
  const replicas = Math.max(1, target.replicas);
  switch (id) {
    case 'cpu_percent': {
      if (!target.cpuLimitMilli || target.cpuLimitMilli <= 0) {
        return { kind: 'inapplicable', reason: 'no CPU limit to compare against' };
      }
      const limit = target.cpuLimitMilli * replicas;
      return {
        kind: 'query',
        promql: `100 * sum(rate(container_cpu_usage_seconds_total{${podSelector(target)}}[${RATE_WINDOW}])) * 1000 / ${limit}`
      };
    }
    case 'memory_percent': {
      if (!target.memoryLimitBytes || target.memoryLimitBytes <= 0) {
        return { kind: 'inapplicable', reason: 'no memory limit to compare against' };
      }
      const limit = target.memoryLimitBytes * replicas;
      return {
        kind: 'query',
        promql: `100 * sum(container_memory_working_set_bytes{${podSelector(target)}}) / ${limit}`
      };
    }
    case 'request_rate':
      if (!target.ingress) return { kind: 'inapplicable', reason: 'no ingress' };
      return { kind: 'query', promql: target.ingress.requestRate(RATE_WINDOW) };
    case 'error_rate':
      if (!target.ingress) return { kind: 'inapplicable', reason: 'no ingress' };
      return { kind: 'query', promql: target.ingress.errorPercent(RATE_WINDOW) };
    case 'latency_avg_ms':
      if (!target.ingress) return { kind: 'inapplicable', reason: 'no ingress' };
      return { kind: 'query', promql: target.ingress.latencyAvgMs(RATE_WINDOW) };
    case 'latency_max_ms':
      if (!target.ingress) return { kind: 'inapplicable', reason: 'no ingress' };
      return { kind: 'query', promql: target.ingress.latencyMaxMs(RATE_WINDOW) };
    case 'cpu_throttled_percent': {
      if (!target.cpuLimitMilli || target.cpuLimitMilli <= 0) {
        return { kind: 'inapplicable', reason: 'no CPU limit to throttle against' };
      }
      return {
        kind: 'query',
        promql: `100 * sum(rate(container_cpu_cfs_throttled_periods_total{${podSelector(target)}}[${RATE_WINDOW}])) / sum(rate(container_cpu_cfs_periods_total{${podSelector(target)}}[${RATE_WINDOW}]))`
      };
    }
    case 'memory_forecast_hours': {
      if (!target.memoryLimitBytes || target.memoryLimitBytes <= 0) {
        return { kind: 'inapplicable', reason: 'no memory limit to run out of' };
      }
      const series = `container_memory_working_set_bytes{${podSelector(target)}}`;
      return {
        kind: 'query',
        promql: `clamp_min(min((${target.memoryLimitBytes} - ${series}) / clamp_min(deriv(${series}[6h]), 1) / 3600), 0)`
      };
    }
    default:
      return { kind: 'inapplicable', reason: 'unknown metric' };
  }
}

export function breaches(comparator: Comparator, value: number, threshold: number): boolean {
  return comparator === 'gt' ? value > threshold : value < threshold;
}

export interface AlertClock {
  firingSince: Date | null;
  okSince: Date | null;
  notifiedAt: Date | null;
  unknownSince: Date | null;
}

export type Sample =
  | { kind: 'breaching'; value: number }
  | { kind: 'ok'; value: number | null }
  | { kind: 'unknown'; reason: string };

export type AlertAction = 'fire' | 'resolve' | 'drop' | null;

export interface Decision {
  next: AlertClock | null;
  action: AlertAction;
}

/**
 * The hysteresis, copied from the crash-state machine because its semantics
 * are the ones "for N minutes" needs. Level-triggered: every pass re-reads
 * truth and moves clocks, never counters. Rise and fall windows are separate,
 * re-assertion resets the recovery clock but keeps the firing clock, and an
 * episode nobody was told about is dropped rather than resolved. Unknown
 * freezes both clocks: the store not answering is neither a breach nor a
 * recovery.
 */
export function decide(
  state: AlertClock | null,
  sample: Sample,
  now: Date,
  windows: { forSeconds: number; recoverSeconds: number }
): Decision {
  const t = now.getTime();
  if (sample.kind === 'unknown') {
    if (!state) return { next: null, action: null };
    return { next: { ...state, unknownSince: state.unknownSince ?? now }, action: null };
  }
  if (sample.kind === 'breaching') {
    if (!state || !state.firingSince) {
      return {
        next: { firingSince: now, okSince: null, notifiedAt: null, unknownSince: null },
        action: null
      };
    }
    const next: AlertClock = { ...state, okSince: null, unknownSince: null };
    if (state.notifiedAt) return { next, action: null };
    if (t - state.firingSince.getTime() < windows.forSeconds * 1000) return { next, action: null };
    return { next: { ...next, notifiedAt: now }, action: 'fire' };
  }
  if (!state || !state.firingSince) return { next: null, action: state ? 'drop' : null };
  if (!state.okSince) {
    return { next: { ...state, okSince: now, unknownSince: null }, action: null };
  }
  if (t - state.okSince.getTime() < windows.recoverSeconds * 1000) {
    return { next: { ...state, unknownSince: null }, action: null };
  }
  return { next: null, action: state.notifiedAt ? 'resolve' : 'drop' };
}

export function recoverSecondsFor(forSeconds: number): number {
  return Math.max(120, Math.min(forSeconds, 600));
}

export function formatValue(id: MetricId, value: number): string {
  const def = metricDef(id);
  if (!def) return String(value);
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return def.unit === 'req/s' ? `${rounded} req/s` : `${rounded}${def.unit}`;
}

export function describeRule(rule: {
  metric: string;
  comparator: string;
  threshold: number;
  forSeconds: number;
}): string {
  const def = metricDef(rule.metric);
  const label = def?.label ?? rule.metric;
  const cmp = rule.comparator === 'lt' ? 'below' : 'above';
  const value = def ? formatValue(def.id, rule.threshold) : String(rule.threshold);
  const minutes = Math.round(rule.forSeconds / 60);
  const span = minutes >= 1 ? `${minutes} min` : `${rule.forSeconds}s`;
  return `${label} ${cmp} ${value} for ${span}`;
}
