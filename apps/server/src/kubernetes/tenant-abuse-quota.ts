import type * as k8s from '@kubernetes/client-node';
import { resolveLimit } from '../quotas/instance-limits';

export const ABUSE_QUOTA_NAME = 'orchard-abuse-quota';
export const ABUSE_LIMIT_RANGE_NAME = 'orchard-ephemeral';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const EPHEMERAL_REQUEST_TOTAL_BYTES = 500 * GiB;
const EPHEMERAL_LIMIT_PODS = 1000;
const DEFAULT_EPHEMERAL_REQUEST_BYTES = 128 * MiB;

export interface AbuseCaps {
  loadBalancers: number | null;
  nodePorts: number | null;
  ephemeralLimitBytes: number;
}

export function abuseCaps(env: NodeJS.ProcessEnv = process.env): AbuseCaps {
  const count = (value: ReturnType<typeof resolveLimit>) =>
    typeof value === 'number' ? value : null;
  const ephemeral = resolveLimit('ephemeralStorageGiB', env);
  return {
    loadBalancers: count(resolveLimit('namespaceLoadBalancers', env)),
    nodePorts: count(resolveLimit('namespaceNodePorts', env)),
    ephemeralLimitBytes: typeof ephemeral === 'number' ? Math.floor(ephemeral * GiB) : 0
  };
}

export function abuseQuotaHard(caps: AbuseCaps): Record<string, string> {
  const hard: Record<string, string> = {};
  if (caps.loadBalancers !== null) hard['services.loadbalancers'] = String(caps.loadBalancers);
  if (caps.nodePorts !== null) hard['services.nodeports'] = String(caps.nodePorts);
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
