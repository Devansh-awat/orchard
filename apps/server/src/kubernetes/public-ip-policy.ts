import { isIP } from 'node:net';
import type * as k8s from '@kubernetes/client-node';

export const SHARING_KEY_ANNOTATION = 'lbipam.cilium.io/sharing-key';
export const SHARING_NAMESPACES_ANNOTATION = 'lbipam.cilium.io/sharing-cross-namespace';
const REQUESTED_IP_ANNOTATIONS = ['lbipam.cilium.io/ips', 'io.cilium/lb-ipam-ips'];

export type ShareWith = '*' | string[];

export function canonicalIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

export function sharingKeyFor(ip: string): string {
  return `shared-${ip.replace(/[^0-9a-zA-Z]/g, '-')}`;
}

export function sharingNamespacesValue(shareWith: ShareWith): string {
  return shareWith === '*' ? '*' : shareWith.join(',');
}

export function sharedIpAnnotations(ip: string, shareWith: ShareWith): Record<string, string> {
  return {
    [SHARING_KEY_ANNOTATION]: sharingKeyFor(ip),
    [SHARING_NAMESPACES_ANNOTATION]: sharingNamespacesValue(shareWith)
  };
}

export function loadBalancerIps(svc: k8s.V1Service): string[] {
  const raw: string[] = [];
  if (svc.spec?.loadBalancerIP) raw.push(svc.spec.loadBalancerIP);
  const ann = svc.metadata?.annotations ?? {};
  for (const key of REQUESTED_IP_ANNOTATIONS) {
    if (ann[key]) raw.push(...ann[key].split(','));
  }
  for (const ingress of svc.status?.loadBalancer?.ingress ?? []) {
    if (ingress.ip) raw.push(ingress.ip);
  }
  const out = new Set<string>();
  for (const value of raw) {
    const ip = canonicalIp(value);
    if (ip) out.add(ip);
  }
  return [...out];
}

export function foreignHolders(
  services: k8s.V1Service[],
  ip: string,
  ownNamespaces: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const svc of services) {
    if (svc.spec?.type !== 'LoadBalancer') continue;
    const namespace = svc.metadata?.namespace ?? '';
    if (ownNamespaces.has(namespace)) continue;
    if (loadBalancerIps(svc).includes(ip)) out.push(`${namespace}/${svc.metadata?.name ?? ''}`);
  }
  return out;
}

export function servicesToAlign(
  services: k8s.V1Service[],
  ip: string,
  shareWith: ShareWith
): k8s.V1Service[] {
  const key = sharingKeyFor(ip);
  const want = sharingNamespacesValue(shareWith);
  return services.filter((svc) => {
    if (svc.spec?.type !== 'LoadBalancer') return false;
    const ann = svc.metadata?.annotations ?? {};
    if (ann[SHARING_KEY_ANNOTATION] !== key) return false;
    if (ann[SHARING_NAMESPACES_ANNOTATION] === want) return false;
    if (shareWith === '*') return true;
    return shareWith.includes(svc.metadata?.namespace ?? '');
  });
}
