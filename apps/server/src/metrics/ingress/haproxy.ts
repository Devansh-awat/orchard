import { alternation, escapeRegex, ratio, type IngressAdapter, type IngressTarget } from './types';

export function haproxySelector(target: IngressTarget): string | null {
  if (!target.namespace || target.services.length === 0) return null;
  return `proxy=~"${escapeRegex(target.namespace)}_svc_(${alternation(target.services)})_.+"`;
}

export const haproxy: IngressAdapter = {
  id: 'haproxy',
  label: 'HAProxy',
  matchesIngressClass: (cls) => cls.includes('haproxy'),
  queries(target) {
    const sel = haproxySelector(target);
    if (!sel) return null;
    const responses = (extra: string, w: string) =>
      `rate(haproxy_backend_http_responses_total{${sel}${extra}}[${w}])`;
    const prefix = `${target.namespace}_svc_`;
    return {
      flavor: 'haproxy',
      percentiles: false,
      routeLabel: 'proxy',
      presence: `haproxy_backend_http_responses_total{${sel}}`,
      requestRate: (w) => `sum(${responses('', w)})`,
      statusRate: (cls, w) => `sum(${responses(`,code="${cls}"`, w)})`,
      errorPercent: (w) => ratio(`sum(${responses(',code="5xx"', w)})`, `sum(${responses('', w)})`),
      latencyAvgMs: () => `max(haproxy_backend_response_time_average_seconds{${sel}}) * 1000`,
      latencyMaxMs: () => `max(haproxy_backend_max_response_time_seconds{${sel}}) * 1000`,
      latencyQuantileMs: () => null,
      routeRequests: (w) => `sum by (proxy) (${responses('', w)})`,
      routeErrors: (w) => `sum by (proxy) (${responses(',code="5xx"', w)})`,
      routeLatencyMs: (w) =>
        `max by (proxy) (avg_over_time(haproxy_backend_response_time_average_seconds{${sel}}[${w}])) * 1000`,
      routeService: (raw) => {
        if (!raw.startsWith(prefix)) return null;
        const rest = raw.slice(prefix.length);
        const cut = rest.lastIndexOf('_');
        return cut > 0 ? rest.slice(0, cut) : rest;
      }
    };
  }
};
