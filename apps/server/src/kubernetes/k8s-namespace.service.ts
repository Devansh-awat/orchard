import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from './kubernetes.service';
import { parseCpu, parseMemory } from './quantity';

/**
 * Per-tenant namespace lifecycle: creation, deletion, ResourceQuota +
 * LimitRange enforcement, per-namespace usage aggregation, RBAC bootstrap
 * for sealed-secrets/tenant operators, and the default-deny NetworkPolicy
 * that isolates each tenant namespace.
 *
 * Shares the kubeconfig with the core KubernetesService via injection;
 * moved bodies use `this.kc` / `this.ensureKubeConfig()` through the
 * private delegates below so they stay byte-identical to the originals.
 */
@Injectable()
export class K8sNamespaceService {
  private readonly logger = new Logger(K8sNamespaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
  ) {}

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  async applyNamespaceQuota(options: {
    namespace: string;
    cpuLimitMilli?: number | null;
    memoryLimitBytes?: number | null;
    maxPods?: number | null;
    maxServices?: number | null;
    defaultPodCpuMilli?: number | null;
    defaultPodMemoryBytes?: number | null;
  }) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const ns = options.namespace;
    const quotaName = 'orchard-org-quota';
    const limitName = 'orchard-defaults';

    const hardQuota: Record<string, string> = {};
    if (options.cpuLimitMilli && options.cpuLimitMilli > 0) {
      hardQuota['requests.cpu'] = `${options.cpuLimitMilli}m`;
      hardQuota['limits.cpu'] = `${options.cpuLimitMilli}m`;
    }
    if (options.memoryLimitBytes && options.memoryLimitBytes > 0) {
      hardQuota['requests.memory'] = String(options.memoryLimitBytes);
      hardQuota['limits.memory'] = String(options.memoryLimitBytes);
    }
    if (options.maxPods && options.maxPods > 0) {
      hardQuota['pods'] = String(options.maxPods);
    }
    if (options.maxServices && options.maxServices > 0) {
      hardQuota['services'] = String(options.maxServices);
    }

    // ResourceQuota
    if (Object.keys(hardQuota).length === 0) {
      try {
        await api.deleteNamespacedResourceQuota(quotaName, ns);
      } catch (error: any) {
        if (error?.response?.statusCode !== 404) {
          console.error('[K8s] delete ResourceQuota failed:', error?.message || error);
        }
      }
    } else {
      const quotaBody: k8s.V1ResourceQuota = {
        metadata: { name: quotaName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
        spec: { hard: hardQuota },
      };
      try {
        await api.replaceNamespacedResourceQuota(quotaName, ns, quotaBody);
      } catch (error: any) {
        if (error?.response?.statusCode === 404) {
          await api.createNamespacedResourceQuota(ns, quotaBody);
        } else {
          throw error;
        }
      }
    }

    // LimitRange — required for per-container defaults so ResourceQuota admission succeeds
    // for pods that don't specify requests. Also caps per-container to org defaults.
    const hasDefaults =
      (options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0) ||
      (options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0);
    // If we set any ResourceQuota with requests.cpu/memory, a LimitRange with defaults is required.
    const needLimitRange =
      hasDefaults ||
      (hardQuota['requests.cpu'] !== undefined || hardQuota['requests.memory'] !== undefined);
    if (!needLimitRange) {
      try {
        await api.deleteNamespacedLimitRange(limitName, ns);
      } catch (error: any) {
        if (error?.response?.statusCode !== 404) {
          console.error('[K8s] delete LimitRange failed:', error?.message || error);
        }
      }
      return;
    }

    const defaultReq: Record<string, string> = {};
    const defaultLim: Record<string, string> = {};
    const cpuDefault = options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0
      ? options.defaultPodCpuMilli
      : 100; // 100m
    const memDefault = options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0
      ? options.defaultPodMemoryBytes
      : 128 * 1024 * 1024; // 128Mi
    defaultReq['cpu'] = `${cpuDefault}m`;
    defaultReq['memory'] = String(memDefault);
    defaultLim['cpu'] = `${cpuDefault * 4}m`;
    defaultLim['memory'] = String(memDefault * 4);

    const limitBody: k8s.V1LimitRange = {
      metadata: { name: limitName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
      spec: {
        limits: [
          {
            type: 'Container',
            default: defaultLim,
            defaultRequest: defaultReq,
          },
        ],
      },
    };

    try {
      await api.replaceNamespacedLimitRange(limitName, ns, limitBody);
    } catch (error: any) {
      if (error?.response?.statusCode === 404) {
        await api.createNamespacedLimitRange(ns, limitBody);
      } else {
        throw error;
      }
    }
  }

  // Aggregate resource requests for an org across all its namespaces.
  async getOrgUsage(namespaces: string[]): Promise<{ cpuMilli: number; memoryBytes: number; pods: number; services: number }> {
    this.ensureKubeConfig();
    if (!this.kc || namespaces.length === 0) return { cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 };
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const nsSet = new Set(namespaces);
    let cpuMilli = 0;
    let memoryBytes = 0;
    let pods = 0;
    let services = 0;
    try {
      const podRes = await api.listPodForAllNamespaces();
      for (const pod of podRes.body.items) {
        const ns = pod.metadata?.namespace;
        if (!ns || !nsSet.has(ns)) continue;
        const phase = pod.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') continue;
        pods += 1;
        for (const c of pod.spec?.containers || []) {
          const req = c.resources?.requests || {};
          if (req.cpu) cpuMilli += parseCpu(String(req.cpu));
          if (req.memory) memoryBytes += parseMemory(String(req.memory));
        }
      }
      const svcRes = await api.listServiceForAllNamespaces();
      for (const s of svcRes.body.items) {
        const ns = s.metadata?.namespace;
        if (ns && nsSet.has(ns)) services += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] getOrgUsage failed:', message);
    }
    return { cpuMilli, memoryBytes, pods, services };
  }

  // Patch resources on a CNPG Cluster (rolling update of postgres pods).
  // Patch a deployment's pod-template container resources (triggers rolling restart).

  async createNamespace(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const body: k8s.V1Namespace = {
        metadata: {
          name: cleanNamespace,
          labels: {
            'orchard.dev/managed': 'true',
            name: cleanNamespace,
            // PodSecurity `baseline` blocks the classic container-escape
            // primitives at admission: hostPath, privileged, hostNetwork,
            // hostPID, hostIPC, dangerous capabilities, host process
            // namespace sharing, etc. We already reject these at the
            // service layer, but admission-time enforcement closes the
            // hole if anything bypasses the API (operators creating
            // pods directly, future code paths, etc).
            //
            // We do not use `restricted` — it forces runAsNonRoot and
            // would break tenant images that bind to :80 or chown at
            // start. gVisor (runtimeClassName) provides the equivalent
            // protection by sandboxing root-in-container.
            'pod-security.kubernetes.io/enforce': 'baseline',
            'pod-security.kubernetes.io/audit': 'restricted',
            'pod-security.kubernetes.io/warn': 'restricted',
          },
        },
      };

      await api.createNamespace(body);

      try {
        await this.createNetworkPolicy(cleanNamespace);
      } catch (networkPolicyError) {
        console.error(`[K8s] Failed to create network policy for namespace ${cleanNamespace}:`, networkPolicyError);
      }

      // Bootstrap the per-tenant Role+RoleBinding that lets the orchard-server
      // ServiceAccount manage secrets and configmaps inside this namespace.
      // The cluster-wide grant on these resources was removed — see
      // charts/orchard/templates/builders.yaml. This namespaced Role is the
      // replacement for tenant namespaces.
      try {
        await this.bootstrapTenantSecretsRbac(cleanNamespace);
      } catch (rbacErr) {
        console.error(`[K8s] Failed to bootstrap tenant secrets RBAC for ${cleanNamespace}:`, rbacErr);
      }

      return {
        success: true,
        namespace: cleanNamespace,
        created: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create namespace',
        message: error.message,
      });
    }
  }

  /**
   * Create a namespaced Role + RoleBinding that grants the orchard-server
   * ServiceAccount full secrets/configmaps management inside `namespace`.
   * Idempotent — swallows 409 if the bindings already exist. This replaces
   * the previous cluster-wide secrets/configmaps grant on the orchard-server
   * ServiceAccount.
   */
  async bootstrapTenantSecretsRbac(namespace: string): Promise<void> {
    const rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const serverNamespace = process.env.ORCHARD_SERVER_NAMESPACE || 'orchard';
    const labels = {
      'app.kubernetes.io/name': 'server',
      'app.kubernetes.io/managed-by': 'leaf',
    };
    const roleName = 'orchard-server-tenant-secrets';
    try {
      await rbacApi.createNamespacedRole(namespace, {
        metadata: { name: roleName, namespace, labels },
        rules: [
          {
            apiGroups: [''],
            resources: ['secrets', 'configmaps'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
          },
        ],
      });
    } catch (e: any) {
      if (e?.response?.statusCode !== 409) throw e;
    }
    try {
      await rbacApi.createNamespacedRoleBinding(namespace, {
        metadata: { name: roleName, namespace, labels },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: roleName },
        subjects: [{ kind: 'ServiceAccount', name: 'orchard-server', namespace: serverNamespace }],
      });
    } catch (e: any) {
      if (e?.response?.statusCode !== 409) throw e;
    }
  }

  async deleteNamespace(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      await api.deleteNamespace(cleanNamespace);

      return {
        success: true,
        namespace: cleanNamespace,
        deleted: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          deleted: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete namespace',
        message: error.message,
      });
    }
  }

  async createNetworkPolicy(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      
      const networkPolicyBody: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'default-deny-all',
          namespace: cleanNamespace,
          labels: {
            'orchard.dev/managed': 'true',
          },
        },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': cleanNamespace,
                    },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'network',
                    },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'orchard',
                    },
                  },
                },
              ],
            },
          ],
          // Egress is allow-listed. Pods may:
          //   1. Talk to other pods in the same tenant namespace.
          //   2. Resolve DNS via kube-dns in kube-system (UDP/TCP 53).
          //   3. Talk to the `network` namespace (ingress controllers).
          //   4. Reach the public internet — but NOT in-cluster Services
          //      (10.0.0.0/8 RFC1918, the service/pod CIDR is in there),
          //      link-local / cloud metadata (169.254.0.0/16), or other
          //      RFC1918 ranges that the platform's own infra may live on.
          // This blocks tenant pods from reaching the kube-apiserver,
          // platform Postgres/Harbor/server, other tenants, and the cloud
          // metadata IMDS — while still letting them call out to the
          // public internet for normal app traffic.
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': cleanNamespace,
                    },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'network',
                    },
                  },
                },
              ],
            },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'kube-system',
                    },
                  },
                  podSelector: {
                    matchLabels: { 'k8s-app': 'kube-dns' },
                  },
                },
              ],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: '0.0.0.0/0',
                    except: [
                      '10.0.0.0/8',
                      '172.16.0.0/12',
                      '192.168.0.0/16',
                      '169.254.0.0/16',
                      '100.64.0.0/10',
                    ],
                  },
                },
              ],
            },
            // CNPG barman sidecars in tenant namespaces stream WAL/backups to
            // r2-proxy, which lives at a ClusterIP in 10.x — blanket RFC1918
            // egress would block backups entirely. Scope the exception to
            // the r2-proxy namespace on port 9000.
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'orchard-r2-proxy',
                    },
                  },
                },
              ],
              ports: [{ protocol: 'TCP', port: 9000 }],
            },
          ],
        },
      };

      await networkingApi.createNamespacedNetworkPolicy(cleanNamespace, networkPolicyBody);

      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

      const allowCiliumIngress = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'allow-cilium-ingress',
          namespace: cleanNamespace,
          labels: { 'orchard.dev/managed': 'true' },
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
                    'app.kubernetes.io/name': 'kubernetes-ingress',
                  },
                },
              ],
            },
          ],
        },
      };
      try {
        await customApi.createNamespacedCustomObject(
          'cilium.io', 'v2', cleanNamespace, 'ciliumnetworkpolicies', allowCiliumIngress,
        );
      } catch (e: any) {
        if (e.response?.statusCode !== 409) throw e;
      }

      const cnpgApiServerPolicy = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'allow-cnpg-apiserver',
          namespace: cleanNamespace,
          labels: { 'orchard.dev/managed': 'true' },
        },
        spec: {
          endpointSelector: {
            matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }],
          },
          egress: [{ toEntities: ['kube-apiserver'] }],
        },
      };
      try {
        await customApi.createNamespacedCustomObject(
          'cilium.io', 'v2', cleanNamespace, 'ciliumnetworkpolicies', cnpgApiServerPolicy,
        );
      } catch (e: any) {
        if (e.response?.statusCode !== 409) throw e;
      }

      return {
        success: true,
        namespace: cleanNamespace,
        created: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create network policy in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create network policy',
        message: error.message,
      });
    }
  }



}
