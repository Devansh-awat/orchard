import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { REGISTRY_PREFIX_LABEL } from './registry-image-policy';
import * as k8s from '@kubernetes/client-node';
import { clusterPods, clusterServiceCounts, type SnapshotRead } from './cluster-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from './kubernetes.service';
import { LeaseService } from '../coordination/lease.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { tenantSecretsBinding, tenantSecretsRole } from './tenant-rbac';
import {
  tenantLimitRange,
  tenantQuotaFloor,
  tenantQuotaHard,
  type PodDefaults
} from './tenant-quota';
import { defaultPodResourcesForImage } from './presets';
import {
  ABUSE_LIMIT_RANGE_NAME,
  ABUSE_QUOTA_NAME,
  abuseCaps,
  abuseLimitRange,
  abuseQuota
} from './tenant-abuse-quota';
import {
  PROJECT_DATABASES_POLICY,
  TENANT_DENY_POLICY,
  TENANT_NAMESPACE_LABEL_SELECTORS,
  ciliumDenyPolicy,
  ciliumIngressPolicy,
  cnpgApiserverPolicy,
  namespaceHasProtectedIngress,
  projectDatabasePolicy,
  projectNamespaces,
  tenantDenyPolicy
} from './security-policies';

export {
  TENANT_NAMESPACE_EGRESS_PEERS,
  TENANT_NAMESPACE_LABELS,
  TENANT_NAMESPACE_LABEL_SELECTORS,
  tenantIngressNamespaces
} from './security-policies';

/**
 * Per-tenant namespace lifecycle: creation, deletion, ResourceQuota +
 * LimitRange enforcement, per-namespace usage aggregation, RBAC bootstrap
 * for sealed-secrets/tenant operators, and the default-deny NetworkPolicy
 * that isolates each tenant namespace.
 *
 * Shares the kubeconfig with the core KubernetesService via injection, through
 * the private delegates below.
 */
@Injectable()
export class K8sNamespaceService implements OnModuleInit {
  private readonly logger = new Logger(K8sNamespaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly lease: LeaseService,
    @Optional() private readonly instanceConfig?: InstanceConfigService
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
    this.instanceConfig?.onLimitsChange(() => this.reapplyAbuseGuards());
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
              `couldn't re-apply the tenant network policy to: ${failed.join(', ')}`
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
    defaultLimit?: PodDefaults | null;
  }) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const ns = options.namespace;
    const quotaName = 'orchard-org-quota';

    const hardQuota = tenantQuotaHard(options, tenantQuotaFloor(process.env));

    await this.applyNamespaceLimitRange(api, ns, hardQuota, options);

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

    await this.applyAbuseGuards(ns).catch((error: any) =>
      this.logger.warn(`abuse quota for ${ns} not applied: ${error?.message ?? error}`)
    );
  }

  private async applyNamespaceLimitRange(
    api: k8s.CoreV1Api,
    ns: string,
    hardQuota: Record<string, string>,
    options: {
      defaultPodCpuMilli?: number | null;
      defaultPodMemoryBytes?: number | null;
      defaultLimit?: PodDefaults | null;
    }
  ) {
    const limitName = 'orchard-defaults';
    const hasDefaults =
      (options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0) ||
      (options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0);
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

    const request = {
      cpuMilli:
        options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0
          ? options.defaultPodCpuMilli
          : 100,
      memoryBytes:
        options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0
          ? options.defaultPodMemoryBytes
          : defaultPodResourcesForImage(null).memoryBytes
    };
    const { defaultRequest, defaultLimit } = tenantLimitRange(
      hardQuota,
      request,
      options.defaultLimit ?? request
    );

    const limitBody: k8s.V1LimitRange = {
      metadata: { name: limitName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
      spec: {
        limits: [
          {
            type: 'Container',
            _default: Object.keys(defaultLimit).length > 0 ? defaultLimit : undefined,
            defaultRequest
          }
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

  async applyAbuseGuards(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const caps = abuseCaps(process.env);
    const range = abuseLimitRange(caps);
    if (range) {
      try {
        await api.replaceNamespacedLimitRange(ABUSE_LIMIT_RANGE_NAME, namespace, range);
      } catch (error: any) {
        if (error?.response?.statusCode !== 404) throw error;
        await api.createNamespacedLimitRange(namespace, range);
      }
    } else {
      await api
        .deleteNamespacedLimitRange(ABUSE_LIMIT_RANGE_NAME, namespace)
        .catch((error: any) => {
          if (error?.response?.statusCode !== 404) throw error;
        });
    }
    const quota = abuseQuota(caps);
    try {
      await api.replaceNamespacedResourceQuota(ABUSE_QUOTA_NAME, namespace, quota);
    } catch (error: any) {
      if (error?.response?.statusCode !== 404) throw error;
      await api.createNamespacedResourceQuota(namespace, quota);
    }
  }

  async removeNamespaceQuota(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const gone = (error: any) => {
      if (error?.response?.statusCode !== 404) throw error;
    };
    await api.deleteNamespacedResourceQuota('orchard-org-quota', namespace).catch(gone);
    await api.deleteNamespacedLimitRange('orchard-defaults', namespace).catch(gone);
  }

  // Aggregate resource requests for an org across all its namespaces.
  async getOrgUsage(
    namespaces: string[],
    opts: SnapshotRead = {}
  ): Promise<{ cpuMilli: number; memoryBytes: number; pods: number; services: number }> {
    this.ensureKubeConfig();
    if (!this.kc || namespaces.length === 0)
      return { cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 };
    const nsSet = new Set(namespaces);
    const [allPods, svcCounts] = await Promise.all([
      clusterPods(this.kc, opts),
      clusterServiceCounts(this.kc, opts)
    ]);

    let cpuMilli = 0;
    let memoryBytes = 0;
    let pods = 0;
    for (const pod of allPods) {
      if (!nsSet.has(pod.namespace)) continue;
      pods += 1;
      // Quota bills what the workload is allowed to consume, not what it
      // reserves: CPU requests are a fraction of the limit (see
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

  protected policyRetryDelaysMs = [250, 1000, 3000];

  private async applyDefaultDenyOrAbandon(api: k8s.CoreV1Api, namespace: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.policyRetryDelaysMs.length; attempt += 1) {
      try {
        await this.createNetworkPolicy(namespace);
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `default-deny network policy for ${namespace} failed (attempt ${attempt + 1}): ${(err as Error)?.message ?? err}`
        );
        const delay = this.policyRetryDelaysMs[attempt];
        if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    await api.deleteNamespace(namespace).catch((err) => {
      this.logger.error(
        `could not remove ${namespace} after its default-deny network policy failed; it carries no workloads but has no policy: ${(err as Error)?.message ?? err}`
      );
    });
    throw new ServiceUnavailableException({
      error: 'Failed to isolate the new namespace',
      message: `The default-deny network policy for ${namespace} could not be applied, so the namespace was not kept.`,
      cause: (lastError as Error)?.message
    });
  }

  async createNamespace(
    namespace: string,
    registryPrefix?: string,
    extraLabels: Record<string, string> = {}
  ) {
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
            ...extraLabels,
            'orchard.my/managed': 'true',
            ...(registryPrefix ? { [REGISTRY_PREFIX_LABEL]: registryPrefix } : {}),
            name: cleanNamespace,
            // PodSecurity `baseline` blocks the classic container-escape
            // primitives at admission: hostPath, privileged, hostNetwork,
            // hostPID, hostIPC, dangerous capabilities, host process
            // namespace sharing, etc. We already reject these at the
            // service layer, but admission-time enforcement closes the
            // hole if anything bypasses the API (operators creating
            // pods directly, future code paths, etc).
            //
            // We do not use `restricted`: it forces runAsNonRoot and
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

      await this.applyDefaultDenyOrAbandon(api, cleanNamespace);

      await this.applyAbuseGuards(cleanNamespace).catch((error: any) =>
        this.logger.warn(
          `abuse quota for ${cleanNamespace} not applied: ${error?.message ?? error}`
        )
      );

      // Bootstrap the per-tenant Role+RoleBinding that lets the orchard-server
      // ServiceAccount manage secrets and configmaps inside this namespace. There is
      // no cluster-wide grant on these resources (see
      // charts/orchard/templates/builders.yaml), so tenant namespaces need this Role.
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
      if (error instanceof ServiceUnavailableException) throw error;
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
   * Idempotent: swallows 409 if the bindings already exist.
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
  private async tenantNamespaceNames(api: k8s.CoreV1Api): Promise<Set<string>> {
    const names = new Set<string>();
    for (const selector of TENANT_NAMESPACE_LABEL_SELECTORS) {
      const namespaces = await api.listNamespace(
        undefined,
        undefined,
        undefined,
        undefined,
        selector
      );
      for (const ns of namespaces.body.items) {
        if (ns.metadata?.name) names.add(ns.metadata.name);
      }
    }
    return names;
  }

  async reapplyAbuseGuards(): Promise<{ updated: number; failed: string[] }> {
    if (!this.lease.canCoordinate) return { updated: 0, failed: [] };
    this.ensureKubeConfig();
    if (!this.kc) return { updated: 0, failed: [] };
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const failed: string[] = [];
    let updated = 0;
    for (const name of await this.tenantNamespaceNames(api)) {
      try {
        await this.applyAbuseGuards(name);
        updated += 1;
      } catch (e: any) {
        this.logger.warn(`couldn't apply the abuse quota for ${name}: ${e?.message}`);
        failed.push(name);
      }
    }
    if (updated) this.logger.log(`re-applied the namespace quota to ${updated} namespace(s)`);
    return { updated, failed };
  }

  async reconcileTenantNetworkPolicies(): Promise<{ updated: string[]; failed: string[] }> {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const updated: string[] = [];
    const failed: string[] = [];

    const names = await this.tenantNamespaceNames(api);

    for (const name of names) {
      try {
        await this.createNetworkPolicy(name);
        await this.applyAbuseGuards(name).catch((e: any) =>
          this.logger.warn(`couldn't apply the abuse quota for ${name}: ${e?.message}`)
        );
        updated.push(name);
      } catch (e: any) {
        this.logger.warn(`couldn't re-apply the network policy for ${name}: ${e?.message}`);
        failed.push(name);
      }
    }

    const projects = await this.prisma.environment.findMany({
      where: { isDefault: false },
      select: { projectId: true },
      distinct: ['projectId']
    });
    for (const { projectId } of projects) {
      await this.applyProjectDatabaseIngress(projectId).catch((e) =>
        this.logger.warn(`couldn't apply database ingress for project ${projectId}: ${e?.message}`)
      );
    }

    return { updated, failed };
  }

  async applyProjectDatabaseIngress(projectId: string) {
    this.ensureKubeConfig();
    if (!this.kc) return;

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    if (!project) return;

    const namespaces = projectNamespaces(project);
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = PROJECT_DATABASES_POLICY;

    for (const namespace of namespaces) {
      if (namespaces.length < 2) {
        await networkingApi.deleteNamespacedNetworkPolicy(name, namespace).catch((e: any) => {
          if (e?.response?.statusCode !== 404) throw e;
        });
        continue;
      }

      const body = projectDatabasePolicy(namespace, namespaces);

      try {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } catch (e: any) {
        if (e?.response?.statusCode !== 409) throw e;
        await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
      }
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

      const networkPolicyBody = tenantDenyPolicy(cleanNamespace, {
        allowProtectionProxy: await namespaceHasProtectedIngress(this.prisma, cleanNamespace),
        clusterExcepts: await this.kubernetes.clusterExceptCidrs()
      });

      // Replace on conflict: a namespace created before a configuration change
      // already has the old policy, and that is precisely the one that needs
      // rewriting.
      try {
        await networkingApi.createNamespacedNetworkPolicy(cleanNamespace, networkPolicyBody);
      } catch (e: any) {
        if (e?.response?.statusCode !== 409) throw e;
        await networkingApi.replaceNamespacedNetworkPolicy(
          TENANT_DENY_POLICY,
          cleanNamespace,
          networkPolicyBody
        );
      }

      // Without Cilium the plain NetworkPolicy above is the whole story, and
      // these two CRs would 404 (no CRD) or 403 (no cilium.io rbac) on every
      // project creation. See https://docs.orchard.hackclub.com/deploy/protection/.
      if (!(await this.kubernetes.isCiliumAvailable())) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: true
        };
      }

      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

      const allowCiliumIngress = ciliumIngressPolicy(cleanNamespace);
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

      const denyPolicy = ciliumDenyPolicy(cleanNamespace);
      if (denyPolicy.spec.egressDeny.length > 0) {
        try {
          await customApi.createNamespacedCustomObject(
            'cilium.io',
            'v2',
            cleanNamespace,
            'ciliumnetworkpolicies',
            denyPolicy
          );
        } catch (e: any) {
          if (e.response?.statusCode !== 409) throw e;
        }
      }

      const cnpgApiServerPolicy = cnpgApiserverPolicy(cleanNamespace);
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
