import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { clusterPods, clusterServiceCounts } from './cluster-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from './kubernetes.service';
import { LeaseService } from '../coordination/lease.service';

/**
 * Namespaces a tenant pod may be reached from, and reach.
 *
 * The ingress controller is the reason this is configurable rather than a
 * constant. This project runs HAProxy in `network`, so that was hardcoded; on
 * k3s Traefik lives in `traefik`, and on a cluster where it lives anywhere else
 * the tenant policy silently blocks it. The visible symptom is not "the site is
 * down" but a certificate that never issues: the ACME HTTP-01 solver is a pod
 * in the tenant namespace, the controller cannot reach it, and Let's Encrypt
 * gets a 502 instead of the token.
 */
export function tenantIngressNamespaces(): string[] {
  const configured = (process.env.TENANT_INGRESS_NAMESPACES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length ? configured : ['network', 'orchard'];
}

function namespacePeers(names: string[]): k8s.V1NetworkPolicyPeer[] {
  return names.map((name) => ({
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } }
  }));
}

import { tenantSecretsBinding, tenantSecretsRole } from './tenant-rbac';
import { tenantQuotaFloor, tenantQuotaHard } from './tenant-quota';

export const TENANT_NAMESPACE_EGRESS_PEERS: k8s.V1NetworkPolicyPeer[] = [
  { namespaceSelector: { matchExpressions: [{ key: 'orchard.my/managed', operator: 'Exists' }] } },
  { namespaceSelector: { matchExpressions: [{ key: 'orchard.dev/managed', operator: 'Exists' }] } }
];

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
export class K8sNamespaceService implements OnModuleInit {
  private readonly logger = new Logger(K8sNamespaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly lease: LeaseService
  ) {}

  /**
   * Tenant policies are written once at namespace creation, so a cluster whose
   * ingress controller is not where the defaults expect leaves every existing
   * project unable to serve an ACME challenge. Re-applying on boot means a
   * configuration fix lands by restarting the server rather than by knowing to
   * run something.
   *
   * Backgrounded and swallowed: this must never hold up or fail startup.
   */
  onModuleInit(): void {
    if (!this.lease.canCoordinate) return;
    setTimeout(() => {
      this.reconcileTenantNetworkPolicies()
        .then(({ updated, failed }) => {
          if (updated.length) {
            this.logger.log(
              `re-applied the tenant network policy to ${updated.length} namespace(s)`
            );
          }
          if (failed.length) {
            this.logger.warn(
              `could not re-apply the tenant network policy to: ${failed.join(', ')}`
            );
          }
        })
        .catch((e) => this.logger.warn(`tenant network policy reconcile skipped: ${e?.message}`));
    }, 5000);
  }

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

    const hardQuota = tenantQuotaHard(options, tenantQuotaFloor(process.env));

    const quotaBody: k8s.V1ResourceQuota = {
      metadata: { name: quotaName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
      spec: { hard: hardQuota }
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

    // LimitRange — required for per-container defaults so ResourceQuota admission succeeds
    // for pods that don't specify requests. Also caps per-container to org defaults.
    const hasDefaults =
      (options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0) ||
      (options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0);
    // If we set any ResourceQuota with requests.cpu/memory, a LimitRange with defaults is required.
    const needLimitRange =
      hasDefaults ||
      hardQuota['requests.cpu'] !== undefined ||
      hardQuota['requests.memory'] !== undefined;
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
    const cpuDefault =
      options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0
        ? options.defaultPodCpuMilli
        : 100; // 100m
    const memDefault =
      options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0
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
            defaultRequest: defaultReq
          } as k8s.V1LimitRangeItem
        ]
      }
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
  async getOrgUsage(
    namespaces: string[]
  ): Promise<{ cpuMilli: number; memoryBytes: number; pods: number; services: number }> {
    this.ensureKubeConfig();
    if (!this.kc || namespaces.length === 0)
      return { cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 };
    const nsSet = new Set(namespaces);
    const [allPods, svcCounts] = await Promise.all([
      clusterPods(this.kc),
      clusterServiceCounts(this.kc)
    ]);

    let cpuMilli = 0;
    let memoryBytes = 0;
    let pods = 0;
    for (const pod of allPods) {
      if (!nsSet.has(pod.namespace)) continue;
      pods += 1;
      // Quota bills what the workload is allowed to consume, not what it
      // reserves — CPU requests are a fraction of the limit (see
      // cpuRequestFromLimitMilli), so summing requests would under-bill.
      cpuMilli += pod.cpuLimitMilli;
      memoryBytes += pod.memoryLimitBytes;
    }

    let services = 0;
    for (const ns of nsSet) services += svcCounts.get(ns) ?? 0;

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
            'orchard.my/managed': 'true',
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
            'pod-security.kubernetes.io/warn': 'restricted'
          }
        }
      };

      await api.createNamespace(body);

      try {
        await this.createNetworkPolicy(cleanNamespace);
      } catch (networkPolicyError) {
        console.error(
          `[K8s] Failed to create network policy for namespace ${cleanNamespace}:`,
          networkPolicyError
        );
      }

      // Bootstrap the per-tenant Role+RoleBinding that lets the orchard-server
      // ServiceAccount manage secrets and configmaps inside this namespace.
      // The cluster-wide grant on these resources was removed — see
      // charts/orchard/templates/builders.yaml. This namespaced Role is the
      // replacement for tenant namespaces.
      try {
        await this.bootstrapTenantSecretsRbac(cleanNamespace);
      } catch (rbacErr) {
        console.error(
          `[K8s] Failed to bootstrap tenant secrets RBAC for ${cleanNamespace}:`,
          rbacErr
        );
      }

      return {
        success: true,
        namespace: cleanNamespace,
        created: true
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        try {
          await this.bootstrapTenantSecretsRbac(cleanNamespace);
        } catch (rbacErr) {
          console.error(
            `[K8s] Failed to bootstrap tenant secrets RBAC for ${cleanNamespace}:`,
            rbacErr
          );
        }
        return {
          success: true,
          namespace: cleanNamespace,
          created: false
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create namespace',
        message: error.message
      });
    }
  }

  /**
   * A namespace name is immutable in Kubernetes, so a project that moves orgs
   * keeps its original `{old-org-slug}-{project-slug}` name forever. Tag it so a
   * human `kubectl`-ing around can still tell where it belongs now: labels are
   * searchable (`kubectl get ns -l orchard.my/current-org=<slug>`), and the
   * annotation carries the full move history. Best-effort.
   */
  async tagNamespaceMoved(
    namespace: string,
    move: { fromOrgSlug: string; toOrgSlug: string; movedBy: string }
  ): Promise<void> {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || '').trim();
    if (!cleanNamespace) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);

    let history: unknown[] = [];
    try {
      const existing: any = await api.readNamespace(cleanNamespace);
      const raw = existing?.body?.metadata?.annotations?.['orchard.my/move-history'];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) history = parsed;
      }
    } catch {
      // Namespace may be absent in a partial/dev environment; the tag is
      // best-effort and must never block the move itself.
    }
    const now = new Date().toISOString();
    history.push({ from: move.fromOrgSlug, to: move.toOrgSlug, at: now, by: move.movedBy });

    const labelSlug =
      move.toOrgSlug
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 63) || 'unknown';
    const patch = {
      metadata: {
        labels: {
          'orchard.my/moved': 'true',
          'orchard.my/current-org': labelSlug
        },
        annotations: {
          'orchard.my/moved-from': move.fromOrgSlug,
          'orchard.my/moved-at': now,
          'orchard.my/move-history': JSON.stringify(history).substring(0, 250000)
        }
      }
    };

    try {
      await api.patchNamespace(
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    } catch (e: any) {
      console.error(`[K8s] Failed to tag moved namespace ${cleanNamespace}:`, e?.message ?? e);
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
    const clusterRole = process.env.TENANT_SECRETS_CLUSTER_ROLE || undefined;
    if (!clusterRole) {
      try {
        await rbacApi.createNamespacedRole(namespace, tenantSecretsRole(namespace));
      } catch (e: any) {
        if (e?.response?.statusCode !== 409) throw e;
      }
    }
    try {
      await rbacApi.createNamespacedRoleBinding(
        namespace,
        tenantSecretsBinding(namespace, serverNamespace, clusterRole)
      );
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
        deleted: true
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          deleted: false
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete namespace',
        message: error.message
      });
    }
  }

  /**
   * Re-apply the tenant policy to every namespace Orchard manages.
   *
   * The policy is written once, when the namespace is created, so changing
   * which namespaces the ingress controller lives in fixes new projects and
   * leaves every existing one broken. Certificates for those keep failing with
   * no visible cause, because nothing re-runs on its own.
   */
  async reconcileTenantNetworkPolicies(): Promise<{ updated: string[]; failed: string[] }> {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const updated: string[] = [];
    const failed: string[] = [];

    const namespaces = await api.listNamespace(
      undefined,
      undefined,
      undefined,
      undefined,
      'orchard.my/managed=true'
    );

    for (const ns of namespaces.body.items) {
      const name = ns.metadata?.name;
      if (!name) continue;
      try {
        await this.createNetworkPolicy(name);
        updated.push(name);
      } catch (e: any) {
        this.logger.warn(`could not re-apply the network policy for ${name}: ${e?.message}`);
        failed.push(name);
      }
    }

    return { updated, failed };
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
            'orchard.my/managed': 'true'
          }
        },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: namespacePeers([cleanNamespace, ...tenantIngressNamespaces()])
            }
          ],
          // Egress is allow-listed. Pods may:
          //   1. Talk to other pods in the same tenant namespace.
          //   2. Resolve DNS via kube-dns in kube-system (UDP/TCP 53).
          //   3. Talk to the `network` namespace (ingress controllers).
          //   4. Reach the public internet — but NOT link-local / cloud
          //      metadata (169.254.0.0/16) or the RFC1918 ranges the
          //      platform's own infra lives on.
          //   5. Reach other Orchard tenant namespaces. Those namespaces are
          //      still default-deny on ingress, so this only lands on what a
          //      tenant has explicitly published via an `-allow-public`
          //      policy — the same surface the public internet already has.
          // This blocks tenant pods from reaching the kube-apiserver,
          // platform Postgres/Harbor/server, other tenants' unpublished
          // services, and the cloud metadata IMDS.
          egress: [
            {
              to: namespacePeers([cleanNamespace, ...tenantIngressNamespaces()])
            },
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
                    except: [
                      '10.0.0.0/8',
                      '172.16.0.0/12',
                      '192.168.0.0/16',
                      '169.254.0.0/16',
                      '100.64.0.0/10'
                    ]
                  }
                }
              ]
            },
            {
              to: TENANT_NAMESPACE_EGRESS_PEERS
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
                      'kubernetes.io/metadata.name': 'orchard-r2-proxy'
                    }
                  }
                }
              ],
              ports: [{ protocol: 'TCP', port: 9000 }]
            }
          ]
        }
      };

      // Replace on conflict: a namespace created before a configuration change
      // already has the old policy, and that is precisely the one that needs
      // rewriting.
      try {
        await networkingApi.createNamespacedNetworkPolicy(cleanNamespace, networkPolicyBody);
      } catch (e: any) {
        if (e?.response?.statusCode !== 409) throw e;
        await networkingApi.replaceNamespacedNetworkPolicy(
          'default-deny-all',
          cleanNamespace,
          networkPolicyBody
        );
      }

      // Without Cilium the plain NetworkPolicy above is the whole story, and
      // these two CRs would 404 (no CRD) or 403 (no cilium.io rbac) on every
      // project creation. See docs/self-hosting.md.
      if (!(await this.kubernetes.isCiliumAvailable())) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: true
        };
      }

      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

      const allowCiliumIngress = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: 'allow-cilium-ingress',
          namespace: cleanNamespace,
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
      try {
        await customApi.createNamespacedCustomObject(
          'cilium.io',
          'v2',
          cleanNamespace,
          'ciliumnetworkpolicies',
          allowCiliumIngress
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
          labels: { 'orchard.my/managed': 'true' }
        },
        spec: {
          endpointSelector: {
            matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }]
          },
          egress: [{ toEntities: ['kube-apiserver'] }]
        }
      };
      try {
        await customApi.createNamespacedCustomObject(
          'cilium.io',
          'v2',
          cleanNamespace,
          'ciliumnetworkpolicies',
          cnpgApiServerPolicy
        );
      } catch (e: any) {
        if (e.response?.statusCode !== 409) throw e;
      }

      return {
        success: true,
        namespace: cleanNamespace,
        created: true
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: false
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create network policy in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create network policy',
        message: error.message
      });
    }
  }
}
