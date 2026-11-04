import {
  alternation,
  escapeRegex,
  ratio,
  type IngressAdapter,
  type IngressTarget,
  type StatusClass
} from './types';

function traefikPattern(target: IngressTarget): string | null {
  if (!target.namespace || target.services.length === 0) return null;
  return `${escapeRegex(target.namespace)}-(${alternation(target.services)})-[^-@]+@kubernetes.*`;
}

export function traefikSelector(target: IngressTarget): string | null {
  const pattern = traefikPattern(target);
  return pattern ? `service=~"${pattern}"` : null;
}

export const traefik: IngressAdapter = {
  id: 'traefik',
  label: 'Traefik',
  matchesIngressClass: (cls) => cls.includes('traefik'),
  presenceMetric: 'traefik_service_requests_total',
  presenceLabel: 'service',
  presencePattern: traefikPattern,
  queries(target) {
    const sel = traefikSelector(target);
    if (!sel) return null;
    const requests = (extra: string, w: string) =>
      `rate(traefik_service_requests_total{${sel}${extra}}[${w}])`;
    const duration = (suffix: string, w: string, by = '') =>
      `sum${by} (rate(traefik_service_request_duration_seconds_${suffix}{${sel}}[${w}]))`;
    const quantile = (q: number, w: string) =>
      `1000 * histogram_quantile(${q}, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{${sel}}[${w}])))`;
    const classRe = (cls: StatusClass) => `,code=~"${cls[0]}.."`;
    const prefix = `${target.namespace}-`;
    return {
      flavor: 'traefik',
      percentiles: true,
      routeLabel: 'service',
      presence: `traefik_service_requests_total{${sel}}`,
      requestRate: (w) => `sum(${requests('', w)})`,
      statusRate: (cls, w) => `sum(${requests(classRe(cls), w)})`,
      errorPercent: (w) => ratio(`sum(${requests(classRe('5xx'), w)})`, `sum(${requests('', w)})`),
      latencyAvgMs: (w) =>
        `1000 * ${duration('sum', w)} / clamp_min(${duration('count', w)}, 1e-9)`,
      latencyMaxMs: (w) => quantile(0.99, w),
      latencyQuantileMs: (q, w) => quantile(q, w),
      routeRequests: (w) => `sum by (service) (${requests('', w)})`,
      routeErrors: (w) => `sum by (service) (${requests(classRe('5xx'), w)})`,
      routeLatencyMs: (w) =>
        `1000 * ${duration('sum', w, ' by (service)')} / clamp_min(${duration('count', w, ' by (service)')}, 1e-9)`,
      routeService: (raw) => {
        const at = raw.indexOf('@');
        const name = at >= 0 ? raw.slice(0, at) : raw;
        if (!name.startsWith(prefix)) return null;
        const rest = name.slice(prefix.length);
        const cut = rest.lastIndexOf('-');
        return cut > 0 ? rest.slice(0, cut) : rest;
      }
    };
  }
};
