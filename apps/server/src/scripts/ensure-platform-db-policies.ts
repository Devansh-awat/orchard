import * as fs from 'fs';
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfigFromPathOrBase64 } from '../kubernetes/kubeconfig';

// Runs from the container entrypoint before migrations so a cluster whose
// policies got mangled can heal itself through the crashloop: the pod
// restarts, this recreates the allows, and the migration that needs the
// database succeeds on the next attempt.
//
// The platform's own database (when it is an in-namespace CNPG cluster)
// needs two guarantees that no installer should have to know about:
//   1. Platform pods (server/mcp/frontend, replication) reach it on 5432.
//   2. The CNPG operator reaches its instance manager on 8000.
// Any network policy that selects the database endpoints flips them to
// default-deny in Cilium, so these allows must exist before anything else
// selects those pods (2026-07-20 incident). Cilium unions allows, so
// applying them alongside installer-owned policies is always safe, and
// they select nothing on installs without an in-namespace CNPG database.

const SA_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

function detectNamespace(): string | null {
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE;
  try {
    return fs.readFileSync(SA_NAMESPACE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function buildPolicies(namespace: string) {
  const operatorNamespace = process.env.CNPG_OPERATOR_NAMESPACE || 'postgresql';
  const metricsNamespace = process.env.PLATFORM_METRICS_NAMESPACE || 'orchard-metrics';
  const r2ProxyNamespace = process.env.PLATFORM_R2_PROXY_NAMESPACE || 'orchard-r2-proxy';
  const dbSelector = {
    matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }]
  };
  return [
    {
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumNetworkPolicy',
      metadata: {
        name: 'orchard-platform-db-control-plane',
        namespace,
        labels: { 'orchard.my/managed': 'true' }
      },
      spec: {
        description:
          'Keep the platform database reachable from platform pods, metrics, and the r2 backup proxy regardless of other policies selecting it.',
        endpointSelector: dbSelector,
        ingress: [
          {
            fromEndpoints: [
              {},
              { matchLabels: { 'io.kubernetes.pod.namespace': metricsNamespace } },
              { matchLabels: { 'io.kubernetes.pod.namespace': r2ProxyNamespace } }
            ]
          }
        ]
      }
    },
    {
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumNetworkPolicy',
      metadata: {
        name: 'orchard-platform-db-operator',
        namespace,
        labels: { 'orchard.my/managed': 'true' }
      },
      spec: {
        description:
          'Allow the CloudNativePG operator to reach the platform database instance manager.',
        endpointSelector: dbSelector,
        ingress: [
          {
            fromEndpoints: [
              {
                matchLabels: {
                  'io.kubernetes.pod.namespace': operatorNamespace,
                  'app.kubernetes.io/name': 'cloudnative-pg'
                }
              }
            ],
            toPorts: [{ ports: [{ port: '8000', protocol: 'TCP' }] }]
          }
        ]
      }
    }
  ];
}

async function main() {
  const namespace = detectNamespace();
  if (!namespace) {
    console.log('[platform-db-policies] not running in kubernetes, skipping');
    return;
  }

  // Same credential order as KubernetesService: the app operates the
  // cluster through an admin kubeconfig, not the pod service account
  // (which has no rbac for cilium policies).
  const kc = new k8s.KubeConfig();
  try {
    const b64 = (process.env.KUBECONFIG_BASE64 || '').trim().replace(/^["']|["']$/g, '');
    if (b64) {
      kc.loadFromString(Buffer.from(b64, 'base64').toString('utf-8'));
    } else if (process.env.KUBECONFIG_PATH || process.env.KUBECONFIG) {
      loadKubeConfigFromPathOrBase64(kc, (process.env.KUBECONFIG_PATH || process.env.KUBECONFIG)!);
    } else if (fs.existsSync(SA_NAMESPACE_FILE)) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
  } catch (e: any) {
    console.log(`[platform-db-policies] no kube credentials, skipping: ${e?.message || e}`);
    return;
  }

  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  for (const policy of buildPolicies(namespace)) {
    const name = policy.metadata.name;
    try {
      await api.createNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumnetworkpolicies',
        policy
      );
      console.log(`[platform-db-policies] created ${name}`);
    } catch (e: any) {
      const status = e?.response?.statusCode;
      if (status === 409) {
        try {
          const existing: any = await api.getNamespacedCustomObject(
            'cilium.io',
            'v2',
            namespace,
            'ciliumnetworkpolicies',
            name
          );
          const body = {
            ...policy,
            metadata: {
              ...policy.metadata,
              resourceVersion: existing.body?.metadata?.resourceVersion
            }
          };
          await api.replaceNamespacedCustomObject(
            'cilium.io',
            'v2',
            namespace,
            'ciliumnetworkpolicies',
            name,
            body
          );
          console.log(`[platform-db-policies] updated ${name}`);
        } catch (re: any) {
          console.log(
            `[platform-db-policies] ${name} exists, replace failed: ${re?.message || re}`
          );
        }
      } else if (status === 404) {
        console.log('[platform-db-policies] cilium CRD not present, skipping');
        return;
      } else {
        console.log(`[platform-db-policies] ${name} failed: ${e?.message || e}`);
      }
    }
  }
}

main()
  .catch((e) => {
    console.log(`[platform-db-policies] skipped: ${e?.message || e}`);
  })
  .then(() => process.exit(0));
