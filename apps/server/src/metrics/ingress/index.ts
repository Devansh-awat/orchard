import { haproxy } from './haproxy';
import { traefik } from './traefik';
import type { IngressAdapter, IngressQueries, IngressTarget } from './types';

export * from './types';
export { haproxySelector } from './haproxy';
export { traefikSelector } from './traefik';

export const INGRESS_ADAPTERS: readonly IngressAdapter[] = [haproxy, traefik];

export function ingressAdapter(id: string): IngressAdapter | null {
  return INGRESS_ADAPTERS.find((a) => a.id === id) ?? null;
}

export function configuredAdapter(env: NodeJS.ProcessEnv = process.env): IngressAdapter | null {
  return ingressAdapter((env.INGRESS_METRICS ?? '').trim().toLowerCase());
}

export function guessedAdapter(env: NodeJS.ProcessEnv = process.env): IngressAdapter {
  const cls = (env.K8S_INGRESS_CLASS ?? env.INGRESS_CLASS ?? '').toLowerCase();
  return INGRESS_ADAPTERS.find((a) => cls && a.matchesIngressClass(cls)) ?? INGRESS_ADAPTERS[0];
}

export function ingressQueries(id: string, target: IngressTarget): IngressQueries | null {
  return ingressAdapter(id)?.queries(target) ?? null;
}
