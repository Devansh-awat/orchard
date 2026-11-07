const SERVER_OWNED_PREFIXES = ['cert-manager.io/', 'acme.cert-manager.io/', 'orchard.my/'];

export const ISSUER_ANNOTATION = 'cert-manager.io/cluster-issuer';

export function isServerOwnedIngressAnnotation(key: string): boolean {
  return SERVER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function tenantIngressAnnotations(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const key = String(rawKey || '').trim();
    if (!key || isServerOwnedIngressAnnotation(key)) continue;
    out[key] = String(value);
  }
  return out;
}

export function isSanctionedIssuerValue(key: string, value: string, issuer: string): boolean {
  if (key === 'cert-manager.io/issuer') return false;
  if (key === ISSUER_ANNOTATION) return value === issuer;
  return true;
}
