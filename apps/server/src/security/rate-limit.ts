import { INGRESS_ADAPTERS } from '../metrics/ingress';
import type { RateLimit } from '../metrics/ingress/types';

export const RATE_LIMIT_MIN_REQUESTS = 1;
export const RATE_LIMIT_MAX_REQUESTS = 100_000;
export const RATE_LIMIT_PERIODS = [1, 10, 60, 300, 3600] as const;

export function parseRateLimit(raw: unknown): RateLimit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const requests = Number(r.requests);
  const periodSeconds = Number(r.periodSeconds);
  if (!Number.isInteger(requests) || requests < RATE_LIMIT_MIN_REQUESTS) return null;
  if (requests > RATE_LIMIT_MAX_REQUESTS) return null;
  if (!(RATE_LIMIT_PERIODS as readonly number[]).includes(periodSeconds)) return null;
  return { requests, periodSeconds };
}

export function adapterForClass(ingressClass: string | null | undefined) {
  if (!ingressClass) return null;
  return INGRESS_ADAPTERS.find((a) => a.matchesIngressClass(ingressClass)) ?? null;
}

export function supportsRateLimit(ingressClass: string | null | undefined): boolean {
  return !!adapterForClass(ingressClass)?.rateLimitAnnotations;
}

export function rateLimitPatch(
  current: Record<string, string> | undefined,
  ingressClass: string | null | undefined,
  limit: RateLimit | null
): Record<string, string | null> | null {
  const adapter = adapterForClass(ingressClass);
  if (!adapter?.rateLimitAnnotations) return null;
  const wanted = adapter.rateLimitAnnotations(limit);
  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(wanted)) {
    const have = current?.[key];
    if (value === null ? have !== undefined : have !== value) patch[key] = value;
  }
  return Object.keys(patch).length ? patch : null;
}
