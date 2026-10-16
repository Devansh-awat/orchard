import type * as k8s from '@kubernetes/client-node';
import { isPullAuthEnvKey } from '../docker/registry-pull-auth';
import { RESOURCE_REF_RE, SHARED_REF_RE, type EnvVar } from './env-resolver';

const MASS_REMOVAL_MIN = 3;

export const INJECTED_ENV: Readonly<Record<string, string>> = { HOST: '0.0.0.0', FORCE_COLOR: '1' };

export interface EnvConflict {
  key: string;
  reason: 'reference' | 'foreign-source' | 'orphan-secret-ref' | 'removed-secret' | 'mass-removal';
}

export interface EnvAdoptionPlan {
  upserts: EnvVar[];
  removals: string[];
  conflicts: EnvConflict[];
}

function hasReference(value: string): boolean {
  SHARED_REF_RE.lastIndex = 0;
  RESOURCE_REF_RE.lastIndex = 0;
  return SHARED_REF_RE.test(value) || RESOURCE_REF_RE.test(value);
}

export function planEnvAdoption(opts: {
  deploymentName: string;
  live: k8s.V1EnvVar[];
  own: EnvVar[];
  resolved: EnvVar[];
}): EnvAdoptionPlan {
  const secretName = `${opts.deploymentName}-env`;
  const own = new Map(opts.own.map((v) => [v.key, v]));
  const resolved = new Map(opts.resolved.map((v) => [v.key, v]));
  const plan: EnvAdoptionPlan = { upserts: [], removals: [], conflicts: [] };
  const seen = new Set<string>();

  for (const entry of opts.live) {
    const key = entry.name;
    if (!key || isPullAuthEnvKey(key)) continue;
    seen.add(key);
    const row = own.get(key);

    if (entry.valueFrom) {
      const ref = entry.valueFrom.secretKeyRef;
      if (ref && ref.name === secretName && ref.key === key) {
        if (!row && !resolved.has(key)) plan.conflicts.push({ key, reason: 'orphan-secret-ref' });
        continue;
      }
      plan.conflicts.push({ key, reason: 'foreign-source' });
      continue;
    }

    const value = entry.value ?? '';
    if (!row) {
      if (resolved.get(key)?.value === value) continue;
      if (INJECTED_ENV[key] === value) continue;
      plan.upserts.push({ key, value, secret: false });
      continue;
    }

    const expected = resolved.get(key)?.value ?? row.value;
    if (value === expected) continue;
    if (hasReference(row.value)) {
      plan.conflicts.push({ key, reason: 'reference' });
      continue;
    }
    plan.upserts.push({ key, value, secret: Boolean(row.secret) });
  }

  const removable: string[] = [];
  for (const row of opts.own) {
    if (seen.has(row.key) || isPullAuthEnvKey(row.key)) continue;
    if (!resolved.has(row.key)) continue;
    if (row.secret) {
      plan.conflicts.push({ key: row.key, reason: 'removed-secret' });
      continue;
    }
    removable.push(row.key);
  }

  const mass = removable.length >= MASS_REMOVAL_MIN && removable.length * 2 >= opts.own.length;
  if (mass) {
    for (const key of removable) plan.conflicts.push({ key, reason: 'mass-removal' });
  } else {
    plan.removals.push(...removable);
  }

  return plan;
}
