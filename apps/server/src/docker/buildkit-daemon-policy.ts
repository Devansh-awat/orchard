import type * as k8s from '@kubernetes/client-node';
import { truncateK8sName } from '../projects/projects.utils';

export const TENANT_KEY_LABEL = 'orchard.my/tenant-key';
export const DAEMON_LABEL = 'orchard.my/buildkit-daemon';
export const DAEMON_PORT = 1234;
export const LEGACY_DAEMON_INGRESS_POLICY = 'buildkit-daemon-ingress';

export function daemonTenantLabel(tenantKey: string): string {
  return truncateK8sName(
    tenantKey
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+/, ''),
    63
  );
}

export function daemonTenantIngressPolicy(opts: {
  namespace: string;
  name: string;
  tenantLabel: string;
}): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/name': 'buildkit-daemon',
        'app.kubernetes.io/managed-by': 'orchard'
      }
    },
    spec: {
      podSelector: {
        matchLabels: { [DAEMON_LABEL]: 'true', [TENANT_KEY_LABEL]: opts.tenantLabel }
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  'app.kubernetes.io/name': 'image-builder',
                  [TENANT_KEY_LABEL]: opts.tenantLabel
                }
              }
            }
          ],
          ports: [{ protocol: 'TCP', port: DAEMON_PORT }]
        }
      ]
    }
  };
}

export function matchesSelector(
  selector: k8s.V1LabelSelector | undefined,
  labels: Record<string, string>
): boolean {
  const required = selector?.matchLabels ?? {};
  return Object.entries(required).every(([k, v]) => labels[k] === v);
}

export function ingressAllows(
  policy: k8s.V1NetworkPolicy,
  daemonLabels: Record<string, string>,
  clientLabels: Record<string, string>,
  port: number
): boolean {
  if (!matchesSelector(policy.spec?.podSelector, daemonLabels)) return false;
  return (policy.spec?.ingress ?? []).some(
    (rule) =>
      (rule.from ?? []).some((peer) => matchesSelector(peer.podSelector, clientLabels)) &&
      (rule.ports ?? []).some((p) => p.port === port)
  );
}
