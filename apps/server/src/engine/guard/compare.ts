import { createHash } from 'crypto';

export type GuardKind = 'NetworkPolicy' | 'CiliumNetworkPolicy' | 'CiliumEnvoyConfig';

export interface GuardManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
    [key: string]: unknown;
  };
  spec?: any;
}

interface CanonicalRules {
  unordered: boolean;
  defaultTcp: boolean;
}

const RULES: Record<GuardKind, CanonicalRules> = {
  NetworkPolicy: { unordered: true, defaultTcp: true },
  CiliumNetworkPolicy: { unordered: true, defaultTcp: false },
  CiliumEnvoyConfig: { unordered: false, defaultTcp: false }
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonical(value: unknown, rules: CanonicalRules, parentKey: string | null): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value
      .map((item) => canonical(item, rules, parentKey))
      .filter((item) => item !== undefined);
    return rules.unordered ? items.sort((a, b) => stable(a).localeCompare(stable(b))) : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = canonical(child, rules, key);
      if (next !== undefined) out[key] = next;
    }
    if (rules.defaultTcp && parentKey === 'ports' && 'port' in out && !('protocol' in out)) {
      out.protocol = 'TCP';
    }
    return out;
  }
  return value;
}

export function canonicalSpec(kind: GuardKind, spec: unknown): unknown {
  return canonical(spec ?? {}, RULES[kind], null) ?? {};
}

export function fingerprint(kind: GuardKind, spec: unknown): string {
  return createHash('sha256')
    .update(stable(canonicalSpec(kind, spec)))
    .digest('hex');
}

export function specDrift(kind: GuardKind, desired: unknown, live: unknown): string[] {
  const want = canonicalSpec(kind, desired) as Record<string, unknown>;
  const have = canonicalSpec(kind, live) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(want), ...Object.keys(have)])].sort();
  return keys.filter((key) => stable(want[key]) !== stable(have[key])).map((key) => `spec.${key}`);
}

export function missingLabels(
  desired: Record<string, string> | undefined,
  live: Record<string, string> | undefined
): string[] {
  return Object.entries(desired ?? {})
    .filter(([key, value]) => live?.[key] !== value)
    .map(([key]) => key);
}
