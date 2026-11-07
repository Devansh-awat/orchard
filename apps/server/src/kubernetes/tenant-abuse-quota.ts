import type * as k8s from '@kubernetes/client-node';

export const ABUSE_QUOTA_NAME = 'orchard-abuse-quota';
export const ABUSE_LIMIT_RANGE_NAME = 'orchard-ephemeral';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const EPHEMERAL_REQUEST_TOTAL_BYTES = 500 * GiB;
const EPHEMERAL_LIMIT_PODS = 1000;
const DEFAULT_EPHEMERAL_REQUEST_BYTES = 128 * MiB;

export interface AbuseCaps {
  loadBalancers: number;
  nodePorts: number;
  ephemeralLimitBytes: number;
}

function count(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function abuseCaps(env: NodeJS.ProcessEnv = process.env): AbuseCaps {
  const limitGiB = Number(env.TENANT_EPHEMERAL_STORAGE_LIMIT_GIB);
  return {
    loadBalancers: count(env.TENANT_QUOTA_FLOOR_LOADBALANCERS, 20),
    nodePorts: count(env.TENANT_QUOTA_FLOOR_NODEPORTS, 10),
    ephemeralLimitBytes:
      env.TENANT_EPHEMERAL_STORAGE_LIMIT_GIB !== undefined &&
      env.TENANT_EPHEMERAL_STORAGE_LIMIT_GIB.trim() !== '' &&
      Number.isFinite(limitGiB) &&
      limitGiB >= 0
        ? Math.floor(limitGiB * GiB)
        : 20 * GiB
  };
}

export function abuseQuotaHard(caps: AbuseCaps): Record<string, string> {
  const hard: Record<string, string> = {
    'services.loadbalancers': String(caps.loadBalancers),
    'services.nodeports': String(caps.nodePorts)
  };
  if (caps.ephemeralLimitBytes > 0) {
    hard['requests.ephemeral-storage'] = String(EPHEMERAL_REQUEST_TOTAL_BYTES);
    hard['limits.ephemeral-storage'] = String(caps.ephemeralLimitBytes * EPHEMERAL_LIMIT_PODS);
  }
  return hard;
}

export function abuseLimitRange(caps: AbuseCaps): k8s.V1LimitRange | null {
  if (caps.ephemeralLimitBytes <= 0) return null;
  return {
    metadata: {
      name: ABUSE_LIMIT_RANGE_NAME,
      labels: { 'app.kubernetes.io/managed-by': 'orchard' }
    },
    spec: {
      limits: [
        {
          type: 'Container',
          _default: { 'ephemeral-storage': String(caps.ephemeralLimitBytes) },
          defaultRequest: { 'ephemeral-storage': String(DEFAULT_EPHEMERAL_REQUEST_BYTES) }
        }
      ]
    }
  };
}

export function abuseQuota(caps: AbuseCaps): k8s.V1ResourceQuota {
  return {
    metadata: { name: ABUSE_QUOTA_NAME, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
    spec: { hard: abuseQuotaHard(caps) }
  };
}
