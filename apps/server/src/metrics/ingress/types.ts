export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

export interface IngressTarget {
  namespace: string;
  services: string[];
}

export interface IngressQueries {
  flavor: string;
  percentiles: boolean;
  routeLabel: string;
  presence: string;
  requestRate(window: string): string;
  statusRate(cls: StatusClass, window: string): string;
  errorPercent(window: string): string;
  latencyAvgMs(window: string): string;
  latencyMaxMs(window: string): string;
  latencyQuantileMs(q: number, window: string): string | null;
  routeRequests(window: string): string;
  routeErrors(window: string): string;
  routeLatencyMs(window: string): string;
  routeService(raw: string): string | null;
}

export interface IngressAdapter {
  id: string;
  label: string;
  matchesIngressClass(ingressClass: string): boolean;
  presenceMetric: string;
  presenceLabel: string;
  presencePattern(target: IngressTarget): string | null;
  presenceScope(): string;
  queries(target: IngressTarget): IngressQueries | null;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function alternation(services: string[]): string {
  return [...new Set(services)].map(escapeRegex).join('|');
}

export function ratio(numerator: string, denominator: string): string {
  return `100 * (${numerator} or vector(0)) / clamp_min(${denominator}, 1e-9)`;
}

const SCOPE_DEFAULTS: Record<string, { job: string; envKey: string }> = {
  traefik: { job: 'traefik', envKey: 'TRAEFIK' },
  haproxy: { job: 'haproxy-ingress', envKey: 'HAPROXY' }
};

export function ingressScopeMatchers(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const def = SCOPE_DEFAULTS[id];
  if (!def) return '';
  const job = (env[`INGRESS_METRICS_${def.envKey}_JOB`] ?? '').trim() || def.job;
  const namespaces = (env[`INGRESS_METRICS_${def.envKey}_NAMESPACE`] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const parts = [`job="${job.replace(/["\\]/g, '')}"`];
  if (namespaces.length) parts.push(`namespace=~"${alternation(namespaces)}"`);
  return parts.join(',');
}
