import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { truncateK8sName } from '../projects/projects.utils';
import { localObjectStore, objectStorage } from '../instance-config/object-storage';

/**
 * Namespaces a tenant pod may be reached from, and reach.
 *
 * The ingress controller is the reason this is configurable rather than a
 * constant. This project runs HAProxy in `network`, on k3s Traefik lives in
 * `traefik`, and on a cluster where it lives anywhere else the tenant policy
 * silently blocks it. The visible symptom is not "the site is down" but a
 * certificate that never issues: the ACME HTTP-01 solver is a pod in the tenant
 * namespace, the controller cannot reach it, and Let's Encrypt gets a 502
 * instead of the token.
 */
export function tenantIngressNamespaces(): string[] {
  const configured = (process.env.TENANT_INGRESS_NAMESPACES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length ? configured : ['network', 'orchard'];
}

export const TENANT_INGRESS_SERVING_PORTS = [80, 443, 8000, 8080, 8443];

export const TENANT_PRIVATE_EGRESS_EXCEPT = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10'
];

export const TENANT_DENY_ENTITIES = ['host', 'remote-node', 'kube-apiserver'];

function portList(raw: string | undefined, fallback: number[]): number[] {
  const value = (raw || '').trim();
  if (!value) return fallback;
  if (value.toLowerCase() === 'none') return [];
  const ports = value
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function tenantIngressPorts(): number[] {
  const ports = portList(process.env.TENANT_INGRESS_PORTS, TENANT_INGRESS_SERVING_PORTS);
  return ports.length ? ports : TENANT_INGRESS_SERVING_PORTS;
}

export function tenantBlockedEgressPorts(): number[] {
  return portList(process.env.TENANT_EGRESS_BLOCK_PORTS, []);
}

export function tenantDenyEntities(): string[] {
  const raw = (process.env.TENANT_DENY_ENTITIES || '').trim();
  if (!raw) return TENANT_DENY_ENTITIES;
  if (raw.toLowerCase() === 'none') return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}

export function egressPortsAvoiding(blocked: number[]): k8s.V1NetworkPolicyPort[] {
  const sorted = [...new Set(blocked)].sort((a, b) => a - b);
  const ports: k8s.V1NetworkPolicyPort[] = [];
  let next = 1;
  for (const port of [...sorted, 65536]) {
    if (port > next) {
      ports.push(
        port - 1 === next
          ? { protocol: 'TCP', port: next }
          : { protocol: 'TCP', port: next, endPort: port - 1 }
      );
    }
    next = port + 1;
  }
  ports.push({ protocol: 'UDP' } as k8s.V1NetworkPolicyPort);
  return ports;
}

export function namespacePeers(names: string[]): k8s.V1NetworkPolicyPeer[] {
  return names.map((name) => ({
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } }
  }));
}

export const TENANT_NAMESPACE_LABELS = ['orchard.my/managed', 'orchard.dev/managed'] as const;

export const TENANT_NAMESPACE_LABEL_SELECTORS = TENANT_NAMESPACE_LABELS.map(
  (label) => `${label}=true`
);

export const TENANT_NAMESPACE_EGRESS_PEERS: k8s.V1NetworkPolicyPeer[] = TENANT_NAMESPACE_LABELS.map(
  (key) => ({ namespaceSelector: { matchExpressions: [{ key, operator: 'Exists' }] } })
);

export function platformMetricsNamespace(): string {
  return process.env.PLATFORM_METRICS_NAMESPACE || 'orchard-metrics';
}

export function r2ProxyNamespace(): string {
  return process.env.PLATFORM_R2_PROXY_NAMESPACE || 'orchard-r2-proxy';
}

export interface ApiserverEndpoints {
  ips: string[];
  ports: number[];
}

export function apiserverEndpointsFrom(
  service: k8s.V1Service,
  endpoints: k8s.V1Endpoints
): ApiserverEndpoints | null {
  const subsets = endpoints.subsets ?? [];
  const backends = subsets.flatMap((s) => (s.addresses ?? []).map((a) => a.ip));
  const backendPorts = subsets.flatMap((s) => (s.ports ?? []).map((p) => p.port));
  if (!backends.length || !backendPorts.length) return null;
  const ips = [...(service.spec?.clusterIPs ?? [service.spec?.clusterIP]), ...backends].filter(
    (ip): ip is string => Boolean(ip) && ip !== 'None'
  );
  const ports = [...(service.spec?.ports ?? []).map((p) => p.port), ...backendPorts];
  return { ips: [...new Set(ips)], ports: [...new Set(ports)] };
}

export interface StorageEgress {
  namespace: string;
  port: number;
}

const IN_CLUSTER_HOST = /^[a-z0-9-]+\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?\.?$/;

export function objectStorageEgress(
  endpoint: string | null = objectStorage().endpoint ?? localObjectStore()?.endpoint ?? null
): StorageEgress | null {
  const configuredPort = Number.parseInt(process.env.OBJECT_STORAGE_PORT || '', 10);
  let url: URL | null = null;
  try {
    url = endpoint
      ? new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`)
      : null;
  } catch {
    url = null;
  }
  const namespace =
    process.env.OBJECT_STORAGE_NAMESPACE || url?.hostname.match(IN_CLUSTER_HOST)?.[1] || null;
  if (!namespace) return null;
  const urlPort = url?.port ? Number(url.port) : url?.protocol === 'http:' ? 80 : 443;
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : urlPort;
  return { namespace, port };
}

export const TENANT_DENY_POLICY = 'default-deny-all';
export const DATABASE_PLATFORM_POLICY = 'allow-database-platform';
export const CNPG_METRICS_PORT = 9187;
export const PROJECT_DATABASES_POLICY = 'allow-project-databases';
export const CILIUM_INGRESS_POLICY = 'allow-cilium-ingress';
export const CILIUM_DENY_POLICY = 'deny-platform-egress';
export const CNPG_APISERVER_POLICY = 'allow-cnpg-apiserver';
export const CNPG_OPERATOR_POLICY = 'allow-cnpg-operator';
export const PROTECTION_PROXY_SOURCE_NAMESPACE = 'orchard';

export const GUARDED_POLICY_LABELS = {
  'orchard.my/managed': 'true',
  'app.kubernetes.io/managed-by': 'orchard'
} as const;

export const PROTECTED_INGRESS_WHERE = {
  OR: [{ protectionMode: { not: 'none' as const } }, { redirectTarget: { not: null } }]
};

export async function namespaceHasProtectedIngress(
  prisma: { ingress: { count(args: { where: any }): Promise<number> } },
  namespace: string
): Promise<boolean> {
  const count = await prisma.ingress.count({ where: { namespace, ...PROTECTED_INGRESS_WHERE } });
  return count > 0;
}

export interface CiliumPolicy {
  apiVersion: 'cilium.io/v2';
  kind: 'CiliumNetworkPolicy' | 'CiliumEnvoyConfig';
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: Record<string, any>;
}

export function tenantDenyPolicy(
  namespace: string,
  opts: {
    ingressNamespaces?: string[];
    allowProtectionProxy?: boolean;
    clusterExcepts?: string[];
    blockedPorts?: number[];
    ingressPorts?: number[];
  } = {}
): k8s.V1NetworkPolicy {
  const ingressNamespaces = opts.ingressNamespaces ?? tenantIngressNamespaces();
  const from = namespacePeers([namespace, ...ingressNamespaces]);
  if (opts.allowProtectionProxy && !ingressNamespaces.includes(PROTECTION_PROXY_SOURCE_NAMESPACE)) {
    from.push(...namespacePeers([PROTECTION_PROXY_SOURCE_NAMESPACE]));
  }
  const blocked = opts.blockedPorts ?? tenantBlockedEgressPorts();
  const servingPorts = (opts.ingressPorts ?? tenantIngressPorts()).map((port) => ({
    protocol: 'TCP',
    port
  }));
  const egressNamespaces = tenantEgressNamespaces(ingressNamespaces);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: TENANT_DENY_POLICY,
      namespace,
      labels: { ...GUARDED_POLICY_LABELS }
    },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from }],
      // Egress is allow-listed. Pods may:
      //   1. Talk to other pods in the same tenant namespace.
      //   2. Resolve DNS via kube-dns in kube-system (UDP/TCP 53).
      //   3. Talk to the ingress controller namespaces on their serving ports
      //      only, so an app can reach a public hostname served by this
      //      cluster without reaching the controller's stats and pprof ports,
      //      which list every tenant's backend. Orchard's own namespace is
      //      left out: it only ever needs to reach into tenants.
      //   4. Reach the public internet, but NOT link-local / cloud
      //      metadata (169.254.0.0/16), the RFC1918 ranges the platform's own
      //      infra lives on, or the addresses of the cluster's own nodes and
      //      apiserver (which can be public), and not outbound mail ports.
      //   5. Reach other Orchard tenant namespaces. Those namespaces are
      //      still default-deny on ingress, so this only lands on what a
      //      tenant has explicitly published via an `-allow-public`
      //      policy: the same surface the public internet already has.
      // This blocks tenant pods from reaching the kube-apiserver,
      // platform Postgres/Harbor/server, other tenants' unpublished
      // services, and the cloud metadata IMDS.
      egress: [
        {
          to: namespacePeers([namespace])
        },
        ...(egressNamespaces.length
          ? [{ to: namespacePeers(egressNamespaces), ports: servingPorts }]
          : []),
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'kube-system'
                }
              },
              podSelector: {
                matchLabels: { 'k8s-app': 'kube-dns' }
              }
            }
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 }
          ]
        },
        {
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: [...TENANT_PRIVATE_EGRESS_EXCEPT, ...(opts.clusterExcepts ?? [])]
              }
            }
          ],
          ...(blocked.length ? { ports: egressPortsAvoiding(blocked) } : {})
        },
        {
          to: TENANT_NAMESPACE_EGRESS_PEERS
        },
        // CNPG barman sidecars in tenant namespaces stream WAL/backups to
        // r2-proxy, which lives at a ClusterIP in 10.x: blanket RFC1918
        // egress would block backups entirely. Scope the exception to
        // the r2-proxy namespace on port 9000.
        {
          to: namespacePeers([r2ProxyNamespace()]),
          ports: [{ protocol: 'TCP', port: 9000 }]
        }
      ]
    }
  };
}

export function tenantEgressNamespaces(ingressNamespaces: string[]): string[] {
  const configured = (process.env.TENANT_EGRESS_NAMESPACES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const platform = process.env.PLATFORM_NAMESPACE || PROTECTION_PROXY_SOURCE_NAMESPACE;
  return ingressNamespaces.filter((name) => name !== platform);
}

export function projectNamespaces(project: {
  namespace: string | null;
  environments: { namespace: string | null }[];
}): string[] {
  return [
    ...new Set([project.namespace, ...project.environments.map((env) => env.namespace)])
  ].filter((ns): ns is string => Boolean(ns));
}

export function projectDatabasePolicy(
  namespace: string,
  namespaces: string[]
): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: PROJECT_DATABASES_POLICY,
      namespace,
      labels: { ...GUARDED_POLICY_LABELS }
    },
    spec: {
      podSelector: { matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }] },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: namespacePeers(namespaces),
          ports: [{ protocol: 'TCP', port: 5432 }]
        }
      ]
    }
  };
}

export function databasePlatformPolicy(
  namespace: string,
  opts: {
    metricsNamespace?: string;
    storage?: StorageEgress | null;
    apiserver?: ApiserverEndpoints | null;
    operatorNamespace?: string | null;
  } = {}
): k8s.V1NetworkPolicy {
  const metricsNamespace = opts.metricsNamespace ?? platformMetricsNamespace();
  const storage = opts.storage === undefined ? objectStorageEgress() : opts.storage;
  const egress: k8s.V1NetworkPolicyEgressRule[] = [];
  if (storage) {
    egress.push({
      to: namespacePeers([storage.namespace]),
      ports: [{ protocol: 'TCP', port: storage.port }]
    });
  }
  if (opts.apiserver?.ips.length) {
    egress.push({
      to: opts.apiserver.ips.map((ip) => ({
        ipBlock: { cidr: ip.includes(':') ? `${ip}/128` : `${ip}/32` }
      })),
      ports: opts.apiserver.ports.map((port) => ({ protocol: 'TCP', port }))
    });
  }
  const ingress: k8s.V1NetworkPolicyIngressRule[] = [
    {
      from: namespacePeers([metricsNamespace]),
      ports: [{ protocol: 'TCP', port: CNPG_METRICS_PORT }]
    }
  ];
  if (opts.operatorNamespace) {
    ingress.push({
      from: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': opts.operatorNamespace }
          },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'cloudnative-pg' } }
        }
      ],
      ports: [{ protocol: 'TCP', port: 8000 }]
    });
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: DATABASE_PLATFORM_POLICY,
      namespace,
      labels: { ...GUARDED_POLICY_LABELS }
    },
    spec: {
      podSelector: { matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }] },
      policyTypes: egress.length ? ['Ingress', 'Egress'] : ['Ingress'],
      ingress,
      ...(egress.length ? { egress } : {})
    }
  };
}

export function ciliumIngressPolicy(namespace: string): CiliumPolicy {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: CILIUM_INGRESS_POLICY,
      namespace,
      labels: { 'orchard.my/managed': 'true' }
    },
    spec: {
      endpointSelector: {},
      ingress: [
        { fromEntities: ['host', 'remote-node', 'ingress'] },
        { fromEndpoints: [{ matchLabels: { 'kubernetes.io/metadata.name': 'orchard' } }] },
        {
          fromEndpoints: [
            {
              matchLabels: {
                'kubernetes.io/metadata.name': 'network',
                'app.kubernetes.io/name': 'kubernetes-ingress'
              }
            }
          ]
        }
      ]
    }
  };
}

export function ciliumDenyPolicy(
  namespace: string,
  opts: { entities?: string[]; blockedPorts?: number[] } = {}
): CiliumPolicy {
  const entities = opts.entities ?? tenantDenyEntities();
  const blocked = opts.blockedPorts ?? tenantBlockedEgressPorts();
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: CILIUM_DENY_POLICY,
      namespace,
      labels: { 'orchard.my/managed': 'true' }
    },
    spec: {
      endpointSelector: {
        matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'DoesNotExist' }]
      },
      egressDeny: [
        ...(entities.length ? [{ toEntities: entities }] : []),
        ...(blocked.length
          ? [
              {
                toPorts: [
                  {
                    ports: blocked.map((port) => ({ port: String(port), protocol: 'TCP' }))
                  }
                ]
              }
            ]
          : [])
      ]
    }
  };
}

export function cnpgApiserverPolicy(namespace: string): CiliumPolicy {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: CNPG_APISERVER_POLICY,
      namespace,
      labels: { 'orchard.my/managed': 'true' }
    },
    spec: {
      endpointSelector: {
        matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }]
      },
      egress: [{ toEntities: ['kube-apiserver'] }]
    }
  };
}

export function cnpgOperatorNamespace(): string {
  return process.env.CNPG_OPERATOR_NAMESPACE || 'postgresql';
}

export function cnpgOperatorPolicy(
  namespace: string,
  operatorNamespace = cnpgOperatorNamespace()
): CiliumPolicy {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: CNPG_OPERATOR_POLICY,
      namespace,
      labels: { 'orchard.my/managed': 'true' }
    },
    spec: {
      endpointSelector: {
        matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }]
      },
      ingress: [
        {
          fromEndpoints: [
            {
              matchLabels: {
                'app.kubernetes.io/name': 'cloudnative-pg',
                'io.kubernetes.pod.namespace': operatorNamespace
              }
            }
          ],
          toPorts: [{ ports: [{ port: '8000', protocol: 'TCP' }] }]
        }
      ]
    }
  };
}

export function publicDatabasePolicyName(clusterName: string): string {
  return truncateK8sName(`${clusterName}-allow-public`, 63);
}

export function publicDatabasePolicy(namespace: string, clusterName: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: publicDatabasePolicyName(clusterName),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'orchard',
        'cnpg.io/cluster': clusterName
      }
    },
    spec: {
      // Target the CNPG primary pod of this cluster.
      podSelector: {
        matchLabels: {
          'cnpg.io/cluster': clusterName
        }
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ ipBlock: { cidr: '0.0.0.0/0' } }, { namespaceSelector: {} }],
          ports: [{ protocol: 'TCP', port: 5432 }]
        }
      ]
    }
  };
}

export function publicDeploymentPolicyName(deploymentName: string): string {
  return truncateK8sName(`${deploymentName}-allow-public`, 63);
}

export function publicDeploymentPorts(
  ports: { targetPort: number; protocol: string | null }[]
): { port: number; protocol: string }[] {
  const deduped = new Map<string, { port: number; protocol: string }>();
  for (const p of ports) {
    const proto = p.protocol?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    deduped.set(`${proto}:${p.targetPort}`, { port: p.targetPort, protocol: proto });
  }
  return Array.from(deduped.values());
}

export function publicDeploymentPolicy(
  namespace: string,
  deploymentName: string,
  ports: { port: number; protocol: string }[]
): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: publicDeploymentPolicyName(deploymentName),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'orchard',
        'app.kubernetes.io/name': deploymentName
      }
    },
    spec: {
      podSelector: {
        matchLabels: { 'app.kubernetes.io/name': deploymentName }
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ ipBlock: { cidr: '0.0.0.0/0' } }, { namespaceSelector: {} }],
          ports: ports.map((p) => ({
            protocol: p.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP',
            port: p.port
          }))
        }
      ]
    }
  };
}

export function basicAuthHtpasswd(username: string, password: string): string {
  const sha1Hash = crypto.createHash('sha1').update(password).digest('base64');
  return `${username}:{SHA}${sha1Hash}`;
}

export function basicAuthSecretName(ingressName: string): string {
  return `${ingressName}-basic-auth`;
}

export function basicAuthEnvoyConfigName(ingressName: string): string {
  return `${ingressName}-auth`;
}

export function basicAuthEnvoyConfig(
  namespace: string,
  ingressName: string,
  htpasswd: string,
  serviceName: string,
  servicePort: number
): CiliumPolicy {
  const name = basicAuthEnvoyConfigName(ingressName);
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumEnvoyConfig',
    metadata: {
      name,
      namespace,
      labels: {
        'orchard.my/managed': 'true',
        'orchard.my/type': 'basic-auth'
      }
    },
    spec: {
      services: [{ name: serviceName, namespace, ports: [servicePort] }],
      resources: [
        {
          '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
          name: `${ingressName}-auth-listener`,
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: name,
                    route_config: {
                      name: `${ingressName}-auth-route`,
                      virtual_hosts: [
                        {
                          name: 'default',
                          domains: ['*'],
                          routes: [
                            {
                              match: { prefix: '/' },
                              route: {
                                cluster: `${namespace}:${serviceName}:${servicePort}`
                              }
                            }
                          ]
                        }
                      ]
                    },
                    http_filters: [
                      {
                        name: 'envoy.filters.http.basic_auth',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.basic_auth.v3.BasicAuth',
                          users: { inline_string: htpasswd }
                        }
                      },
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router'
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  };
}
