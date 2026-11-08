import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import {
  isDatabaseImage,
  MANAGED_DATABASE_MIN_MEMORY_BYTES,
  podDefaultsFor,
  podResourcesFor
} from '../kubernetes/presets';
import { namespaceRoom, type MirroredWorkload, type PodDefaults } from '../kubernetes/tenant-quota';
import {
  isUnlimitedRow,
  liveMatchesMode,
  NO_LIMITS_APP_REQUESTS,
  NO_LIMITS_DATABASE_REQUESTS,
  type PodSizing
} from '../kubernetes/resource-spec';
import { LeaseService } from '../coordination/lease.service';
import {
  InstanceSettingsService,
  type ResourceLimitsMode
} from '../instance-settings/instance-settings.service';
import { formatBytes } from '../projects/projects.utils';
import { ownerLeftAllowance } from './owner-allowance';
import {
  allowanceCommitment,
  declaredProjectUsage,
  groupByOwner,
  memberAllowance,
  ownedUsage
} from './member-usage';

const VIEW_SNAPSHOT = { staleMs: 60_000 };

const QUOTA_SWEEP_BATCH = 10;
const QUOTA_SWEEP_BOOT_DELAY_MS = 15_000;

interface RolloutRow {
  projectId: string;
  image?: string | null;
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | number | null;
}

const OWNED_PROJECT_SELECT = {
  id: true,
  name: true,
  deployments: {
    select: {
      id: true,
      name: true,
      cpuRequestMilli: true,
      memoryRequestBytes: true,
      replicas: true,
      stopped: true
    }
  },
  databases: {
    select: {
      id: true,
      name: true,
      cpuRequestMilli: true,
      memoryRequestBytes: true,
      replicas: true
    }
  }
} as const;

export interface Caps {
  cpuLimitMilli: number | null;
  memoryLimitBytes: number | null;
  maxPods: number | null;
  maxServices: number | null;
}

type EffectiveProjectCaps = Caps & {
  source: {
    cpu: 'project' | 'org' | null;
    memory: 'project' | 'org' | null;
    pods: 'project' | 'org' | null;
    services: 'project' | 'org' | null;
  };
};

export function assertPositiveOrBlank(fields: Record<string, number | null | undefined>): void {
  for (const [label, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        `${label} must be greater than 0. Leave it blank for no limit.`
      );
    }
  }
}

@Injectable()
export class QuotasService implements OnModuleInit {
  private readonly logger = new Logger(QuotasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
    private readonly k8sNamespace: K8sNamespaceService,
    private readonly settings: InstanceSettingsService,
    private readonly lease: LeaseService
  ) {}

  onModuleInit(): void {
    if (!this.lease.canCoordinate) return;
    setTimeout(() => {
      this.limitsOff()
        .then((off) => (off ? this.clearAllQuotas() : this.applyCappedProjects()))
        .catch((e) => this.logger.warn(`quota sweep skipped: ${e?.message ?? e}`));
    }, QUOTA_SWEEP_BOOT_DELAY_MS);
  }

  private async applyCappedProjects(): Promise<void> {
    const capped = { OR: [{ cpuLimitMilli: { not: null } }, { memoryLimitBytes: { not: null } }] };
    const projects = await this.prisma.project.findMany({
      where: { OR: [capped, { organization: capped }] },
      select: { id: true }
    });
    for (let i = 0; i < projects.length; i += QUOTA_SWEEP_BATCH) {
      await Promise.allSettled(
        projects.slice(i, i + QUOTA_SWEEP_BATCH).map((p) =>
          this.applyProjectQuota(p.id).catch((err) => {
            this.logger.warn(`quota for project ${p.id} not applied: ${err?.message ?? err}`);
          })
        )
      );
    }
  }

  private async namespaceWorkloads(
    namespaces: string[]
  ): Promise<Map<string, MirroredWorkload[]> | null> {
    try {
      const rows = await this.prisma.k8sObject.findMany({
        where: {
          kind: { in: ['Deployment', 'CronJob', 'Cluster'] },
          namespace: { in: namespaces }
        },
        select: { kind: true, namespace: true, manifest: true }
      });
      const out = new Map<string, MirroredWorkload[]>();
      for (const row of rows) {
        if (!row.namespace) continue;
        const list = out.get(row.namespace) ?? [];
        list.push({ kind: row.kind, manifest: row.manifest });
        out.set(row.namespace, list);
      }
      return out;
    } catch (err: any) {
      this.logger.warn(`couldn't read workloads for the quota: ${err?.message ?? err}`);
      return null;
    }
  }

  async limitsOff(): Promise<boolean> {
    return (await this.settings.getResourceLimitsState()).value === 'off';
  }

  private withNoLimits(size: { cpuMilli: number; memoryBytes: number }, image?: string | null) {
    return {
      ...size,
      noLimits: isDatabaseImage(image)
        ? { ...NO_LIMITS_DATABASE_REQUESTS }
        : { ...NO_LIMITS_APP_REQUESTS }
    };
  }

  async podSizing(
    projectId: string,
    override?: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    image?: string | null
  ): Promise<PodSizing> {
    const size = await this.resolvePodResources(projectId, override, image);
    return (await this.limitsOff()) ? this.withNoLimits(size, image) : size;
  }

  async prepareRollout(row: RolloutRow): Promise<PodSizing | undefined> {
    const state = await this.settings.getResourceLimitsState();
    if (state.dbValue === null && state.envOverride === null) return undefined;
    if (state.value === 'on' && isUnlimitedRow(row)) return undefined;
    const size = await this.resolvePodResources(
      row.projectId,
      {
        cpuRequestMilli: row.cpuRequestMilli,
        memoryRequestBytes: row.memoryRequestBytes != null ? Number(row.memoryRequestBytes) : null
      },
      row.image
    );
    if (state.value === 'off') {
      await this.clearProjectQuota(row.projectId);
      return this.withNoLimits(size, row.image);
    }
    await this.applyProjectQuota(row.projectId).catch((err) => {
      this.logger.warn(`quota for project ${row.projectId} not applied: ${err?.message ?? err}`);
    });
    return size;
  }

  async restartPending(deployment: {
    id: string;
    name: string;
    namespace: string;
    stopped?: boolean | null;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | number | null;
  }): Promise<boolean> {
    if (deployment.stopped) return false;
    const state = await this.settings.getResourceLimitsState();
    if (state.dbValue === null && state.envOverride === null) return false;
    if (state.value === 'on' && isUnlimitedRow(deployment)) return false;
    const live = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Deployment', namespace: deployment.namespace, name: deployment.name },
      select: { manifest: true }
    });
    if (!live) return false;
    const manifest = live.manifest as any;
    return !liveMatchesMode(
      state.value,
      manifest?.spec?.template?.spec?.containers?.[0]?.resources
    );
  }

  private async projectNamespaces(projectId: string): Promise<string[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    if (!project) return [];
    return Array.from(
      new Set([project.namespace, ...project.environments.map((e) => e.namespace)])
    );
  }

  async clearProjectQuota(projectId: string): Promise<void> {
    const namespaces = await this.projectNamespaces(projectId);
    const results = await Promise.allSettled(
      namespaces.map((namespace) => this.k8sNamespace.removeNamespaceQuota(namespace))
    );
    const failed = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    if (failed) {
      throw new ServiceUnavailableException(
        `Could not remove the old resource limits from this project: ${failed.reason?.message ?? failed.reason}`
      );
    }
  }

  async clearAllQuotas(): Promise<void> {
    const projects = await this.prisma.project.findMany({ select: { id: true } });
    for (let i = 0; i < projects.length; i += QUOTA_SWEEP_BATCH) {
      await Promise.allSettled(
        projects.slice(i, i + QUOTA_SWEEP_BATCH).map((p) =>
          this.clearProjectQuota(p.id).catch((err) => {
            this.logger.warn(`quota for project ${p.id} not removed: ${err?.message ?? err}`);
          })
        )
      );
    }
  }

  sweepQuotasInBackground(): void {
    if (!this.lease.canCoordinate) return;
    void this.clearAllQuotas().catch((err) => {
      this.logger.warn(`quota sweep failed: ${err?.message ?? err}`);
    });
  }

  // Resolve the caps applied to a project namespace.
  // Precedence: project override > org cap. Nulls propagate "unlimited".
  async resolveProjectCaps(projectId: string): Promise<{
    caps: EffectiveProjectCaps;
    defaultPodCpuMilli: number | null;
    defaultPodMemoryBytes: number | null;
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true,
        maxServices: true,
        organization: {
          select: {
            cpuLimitMilli: true,
            memoryLimitBytes: true,
            maxPods: true,
            maxServices: true,
            defaultPodCpuMilli: true,
            defaultPodMemoryBytes: true
          }
        }
      }
    });
    if (!project) throw new NotFoundException('Project not found');

    const pick = <T>(
      a: T | null,
      b: T | null
    ): { value: T | null; source: 'project' | 'org' | null } => {
      if (a !== null && a !== undefined) return { value: a, source: 'project' };
      if (b !== null && b !== undefined) return { value: b, source: 'org' };
      return { value: null, source: null };
    };

    const cpu = pick(project.cpuLimitMilli, project.organization.cpuLimitMilli);
    const mem = pick(
      project.memoryLimitBytes ? Number(project.memoryLimitBytes) : null,
      project.organization.memoryLimitBytes ? Number(project.organization.memoryLimitBytes) : null
    );
    const pods = pick(project.maxPods, project.organization.maxPods);
    const svcs = pick(project.maxServices, project.organization.maxServices);

    return {
      caps: {
        cpuLimitMilli: cpu.value,
        memoryLimitBytes: mem.value,
        maxPods: pods.value,
        maxServices: svcs.value,
        source: { cpu: cpu.source, memory: mem.source, pods: pods.source, services: svcs.source }
      },
      defaultPodCpuMilli: project.organization.defaultPodCpuMilli,
      defaultPodMemoryBytes: project.organization.defaultPodMemoryBytes
        ? Number(project.organization.defaultPodMemoryBytes)
        : null
    };
  }

  // Resolve the per-pod resources for a deployment/db/template resource.
  // Precedence: explicit override on the resource → org default → hardcoded fallback.
  async resolvePodResources(
    projectId: string,
    override?: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    image?: string | null
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    const { defaultPodCpuMilli, defaultPodMemoryBytes } = await this.resolveProjectCaps(projectId);
    // Floor applies to the explicit override too: a user asking for 128Mi of
    // Postgres is asking for a database that OOMKills itself during its backup.
    return podResourcesFor(image, { defaultPodCpuMilli, defaultPodMemoryBytes }, override);
  }

  // Push the effective caps for a project to Kubernetes (ResourceQuota + LimitRange).
  async applyProjectQuota(projectId: string) {
    if (await this.limitsOff()) {
      await this.clearProjectQuota(projectId).catch((err) => {
        this.logger.warn(`quota for project ${projectId} not removed: ${err?.message ?? err}`);
      });
      return;
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    if (!project) return;
    const { caps, defaultPodCpuMilli, defaultPodMemoryBytes } =
      await this.resolveProjectCaps(projectId);
    // RollingUpdate briefly runs old and new pods side by side (maxSurge 25%),
    // so the namespace ResourceQuota gets matching headroom on top of the cap,
    // otherwise a namespace running at its cap can never replace a pod: the
    // surge pod is rejected at admission and the rollout wedges. Steady-state
    // usage is still held to the real cap by the API-layer checks
    // (enforceProjectCapForNewPod / enforceOrgCapForNewPod / member allowances).
    const SURGE_HEADROOM = 1.25;
    const withHeadroom = (v: number | null) => (v ? Math.ceil(v * SURGE_HEADROOM) : v);
    const podsWithHeadroom = caps.maxPods
      ? caps.maxPods + Math.max(1, Math.ceil(caps.maxPods * 0.25))
      : caps.maxPods;
    // Each environment has its own namespace; push the project's cap as the
    // per-namespace ceiling to every one of them (real per-org/member totals
    // are still held by the API-layer aggregation). Union the legacy project
    // namespace in case an environment row is missing (belt and suspenders).
    const namespaces = Array.from(
      new Set<string>([project.namespace, ...project.environments.map((e) => e.namespace)])
    );
    const defaults: PodDefaults = podResourcesFor(null, {
      defaultPodCpuMilli,
      defaultPodMemoryBytes
    });
    const [workloads, state] = await Promise.all([
      this.namespaceWorkloads(namespaces),
      this.settings.getResourceLimitsState()
    ]);
    const modeChosen = state.dbValue !== null || state.envOverride !== null;
    const room = (namespace: string) => {
      if (!workloads) {
        return {
          hasWorkloadWithoutLimits: false,
          needed: { cpuMilli: 0, memoryBytes: 0 },
          defaultLimit: {
            cpuMilli: defaults.cpuMilli,
            memoryBytes: Math.max(defaults.memoryBytes, MANAGED_DATABASE_MIN_MEMORY_BYTES)
          }
        };
      }
      return namespaceRoom(workloads.get(namespace) ?? [], defaults);
    };
    const results = await Promise.allSettled(
      namespaces.map((namespace) => {
        const { hasWorkloadWithoutLimits, needed, defaultLimit } = room(namespace);
        const ceiling = (cap: number | null, need: number) => {
          const capped = withHeadroom(cap);
          if (!capped || !modeChosen || !hasWorkloadWithoutLimits) return capped;
          return Math.max(capped, withHeadroom(need) ?? 0);
        };
        return this.k8sNamespace.applyNamespaceQuota({
          namespace,
          cpuLimitMilli: ceiling(caps.cpuLimitMilli, needed.cpuMilli),
          memoryLimitBytes: ceiling(caps.memoryLimitBytes, needed.memoryBytes),
          maxPods: podsWithHeadroom,
          maxServices: caps.maxServices,
          defaultPodCpuMilli,
          defaultPodMemoryBytes,
          defaultLimit
        });
      })
    );
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `quota for namespace ${namespaces[index]} not applied: ${result.reason?.message ?? result.reason}`
        );
      }
    }
  }

  // Reapply quotas to every project in an org (after org-level caps change).
  async applyAllProjectsForOrg(organizationId: string) {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: { id: true }
    });
    await Promise.allSettled(
      projects.map((p) =>
        this.applyProjectQuota(p.id).catch((err) => {
          console.error(`[Quotas] Failed to apply quota for project ${p.id}:`, err);
        })
      )
    );
  }

  // Returns namespaces for `organizationId` plus any orgs sharing its quotaGroupId.
  // Linked orgs share both the cap and the usage pool: total usage is summed across them.
  private async getQuotaGroupNamespaces(organizationId: string): Promise<string[]> {
    // Union the project's own namespace with every environment namespace so
    // staging/dev pods count toward org caps. The prod env namespace equals
    // the project namespace, so a Set dedupes the overlap.
    const projectSelect = {
      namespace: true,
      environments: { select: { namespace: true } }
    } as const;
    const self = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { quotaGroupId: true, projects: { select: projectSelect } }
    });
    if (!self) return [];
    const namespaces = new Set<string>();
    const collect = (projects: { namespace: string; environments: { namespace: string }[] }[]) => {
      for (const p of projects) {
        namespaces.add(p.namespace);
        for (const e of p.environments) namespaces.add(e.namespace);
      }
    };
    collect(self.projects);
    if (self.quotaGroupId) {
      const others = await this.prisma.organization.findMany({
        where: { quotaGroupId: self.quotaGroupId, id: { not: organizationId } },
        select: { projects: { select: projectSelect } }
      });
      for (const o of others) collect(o.projects);
    }
    return Array.from(namespaces);
  }

  // Org-wide admission check used at deploy time. Throws if the requested delta would push
  // the org past its org-wide cap. Additive resources only: cpu/memory.
  async enforceOrgCapForNewPod(
    organizationId: string,
    requested: { cpuMilli: number; memoryBytes: number }
  ) {
    if (await this.limitsOff()) return;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true
      }
    });
    if (!org) return;
    const capCpu = org.cpuLimitMilli;
    const capMem = org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null;
    const capPods = org.maxPods;
    if (!capCpu && !capMem && !capPods) return;
    const namespaces = await this.getQuotaGroupNamespaces(organizationId);
    const usage = await this.k8sNamespace.getOrgUsage(namespaces);

    if (capCpu && usage.cpuMilli + requested.cpuMilli > capCpu) {
      throw new ForbiddenException(
        `Organization CPU quota exceeded: need ${usage.cpuMilli + requested.cpuMilli}m, limit ${capCpu}m`
      );
    }
    if (capMem && usage.memoryBytes + requested.memoryBytes > capMem) {
      throw new ForbiddenException(
        `Organization memory quota exceeded: need ${formatBytes(usage.memoryBytes + requested.memoryBytes)}, limit ${formatBytes(capMem)}`
      );
    }
    if (capPods && usage.pods + 1 > capPods) {
      throw new ForbiddenException(
        `Organization pod count quota exceeded: ${usage.pods}/${capPods}`
      );
    }
  }

  async enforceProjectCapForNewPod(
    projectId: string,
    requested: { cpuMilli: number; memoryBytes: number; pods: number },
    excludeDeploymentId?: string
  ) {
    if (await this.limitsOff()) return;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true,
        namespace: true,
        environments: { select: { namespace: true } },
        organization: { select: { defaultPodCpuMilli: true, defaultPodMemoryBytes: true } },
        deployments: {
          select: {
            id: true,
            image: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true,
            replicas: true,
            stopped: true
          }
        },
        databases: {
          select: { status: true, cpuRequestMilli: true, memoryRequestBytes: true, replicas: true }
        }
      }
    });
    if (!project) return;
    const capCpu = project.cpuLimitMilli;
    const capMem = project.memoryLimitBytes ? Number(project.memoryLimitBytes) : null;
    const capPods = project.maxPods;
    if (!capCpu && !capMem && !capPods) return;

    const declared = declaredProjectUsage(project, project.organization, excludeDeploymentId);
    const live = await this.k8sNamespace.getOrgUsage(
      Array.from(new Set([project.namespace, ...project.environments.map((e) => e.namespace)]))
    );
    const needCpu = Math.max(declared.cpuMilli, live.cpuMilli) + requested.cpuMilli;
    const needMem = Math.max(declared.memoryBytes, live.memoryBytes) + requested.memoryBytes;
    const needPods = Math.max(declared.pods, live.pods) + requested.pods;

    if (capCpu && requested.cpuMilli > 0 && needCpu > capCpu) {
      throw new ForbiddenException(
        `Project CPU quota exceeded: need ${needCpu}m, limit ${capCpu}m`
      );
    }
    if (capMem && requested.memoryBytes > 0 && needMem > capMem) {
      throw new ForbiddenException(
        `Project memory quota exceeded: need ${formatBytes(needMem)}, limit ${formatBytes(capMem)}`
      );
    }
    if (capPods && requested.pods > 0 && needPods > capPods) {
      throw new ForbiddenException(`Project pod count quota exceeded: ${needPods}/${capPods}`);
    }
  }

  /** Org total resource usage: lightweight, no caps/metadata. */
  async getOrgTotalUsage(
    organizationId: string,
    namespaces: string[]
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    if (namespaces.length === 0) return { cpuMilli: 0, memoryBytes: 0 };
    const usage = await this.k8sNamespace.getOrgUsage(namespaces, VIEW_SNAPSHOT);
    return { cpuMilli: usage.cpuMilli, memoryBytes: usage.memoryBytes };
  }

  // Public read API (used by UI).
  async getOrgUsageWithCaps(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true,
        maxServices: true,
        maxProjects: true,
        maxEnvironments: true,
        maxDeployments: true,
        defaultPodCpuMilli: true,
        defaultPodMemoryBytes: true,
        quotaGroupId: true
      }
    });
    if (!org) throw new NotFoundException('Organization not found');
    const [usage, connections] = await Promise.all([
      this.getQuotaGroupNamespaces(organizationId).then((namespaces) =>
        this.k8sNamespace.getOrgUsage(namespaces, VIEW_SNAPSHOT)
      ),
      this.getOrgConnections(organizationId)
    ]);
    return {
      org: {
        id: org.id,
        name: org.name,
        cpuLimitMilli: org.cpuLimitMilli || null,
        memoryLimitBytes: org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null,
        maxPods: org.maxPods || null,
        maxServices: org.maxServices || null,
        maxProjects: org.maxProjects || null,
        maxEnvironments: org.maxEnvironments || null,
        maxDeployments: org.maxDeployments || null,
        defaultPodCpuMilli: org.defaultPodCpuMilli || null,
        defaultPodMemoryBytes: org.defaultPodMemoryBytes ? Number(org.defaultPodMemoryBytes) : null,
        quotaGroupId: org.quotaGroupId
      },
      usage,
      connections
    };
  }

  // List other orgs sharing this org's quotaGroupId (empty if not linked).
  async getOrgConnections(
    organizationId: string
  ): Promise<{ id: string; name: string; slug: string }[]> {
    const self = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { quotaGroupId: true }
    });
    if (!self?.quotaGroupId) return [];
    const others = await this.prisma.organization.findMany({
      where: { quotaGroupId: self.quotaGroupId, id: { not: organizationId } },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' }
    });
    return others;
  }

  // Connect two orgs into a shared-quota group. Caps from `primaryOrgId` are mirrored
  // onto the other org. If either is already in a group, the groups merge.
  async linkOrganizations(primaryOrgId: string, otherOrgId: string) {
    if (primaryOrgId === otherOrgId) {
      throw new ForbiddenException("You can't connect an organization to itself");
    }
    const [primary, other] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: primaryOrgId },
        select: {
          id: true,
          quotaGroupId: true,
          cpuLimitMilli: true,
          memoryLimitBytes: true,
          maxPods: true,
          maxServices: true,
          defaultPodCpuMilli: true,
          defaultPodMemoryBytes: true
        }
      }),
      this.prisma.organization.findUnique({
        where: { id: otherOrgId },
        select: { id: true, quotaGroupId: true }
      })
    ]);
    if (!primary) throw new NotFoundException('Primary organization not found');
    if (!other) throw new NotFoundException('Other organization not found');

    // Pick the group id: reuse an existing one if present, otherwise mint a new one.
    const groupId = primary.quotaGroupId ?? other.quotaGroupId ?? randomUUID();

    // Mirror caps from primary onto every org joining the group (including reassigned ones).
    const targetIds = new Set<string>([primary.id, other.id]);
    if (primary.quotaGroupId) {
      const existing = await this.prisma.organization.findMany({
        where: { quotaGroupId: primary.quotaGroupId },
        select: { id: true }
      });
      for (const o of existing) targetIds.add(o.id);
    }
    if (other.quotaGroupId && other.quotaGroupId !== primary.quotaGroupId) {
      const existing = await this.prisma.organization.findMany({
        where: { quotaGroupId: other.quotaGroupId },
        select: { id: true }
      });
      for (const o of existing) targetIds.add(o.id);
    }

    await this.prisma.organization.updateMany({
      where: { id: { in: Array.from(targetIds) } },
      data: {
        quotaGroupId: groupId,
        cpuLimitMilli: primary.cpuLimitMilli,
        memoryLimitBytes: primary.memoryLimitBytes,
        maxPods: primary.maxPods,
        maxServices: primary.maxServices,
        defaultPodCpuMilli: primary.defaultPodCpuMilli,
        defaultPodMemoryBytes: primary.defaultPodMemoryBytes
      }
    });
    // Reapply quotas to every project of every org in the group so K8s ResourceQuotas match.
    await Promise.allSettled(Array.from(targetIds).map((id) => this.applyAllProjectsForOrg(id)));
    return { quotaGroupId: groupId, orgIds: Array.from(targetIds) };
  }

  // Remove an org from its quota group. If only one org remains, clear that one too.
  async unlinkOrganization(organizationId: string) {
    const self = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { quotaGroupId: true }
    });
    if (!self?.quotaGroupId) return { quotaGroupId: null };
    const groupId = self.quotaGroupId;
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { quotaGroupId: null }
    });
    const remaining = await this.prisma.organization.findMany({
      where: { quotaGroupId: groupId },
      select: { id: true }
    });
    if (remaining.length <= 1) {
      await this.prisma.organization.updateMany({
        where: { quotaGroupId: groupId },
        data: { quotaGroupId: null }
      });
    }
    // Reapply quotas since the shared-pool perspective changed for everyone touched.
    const touched = [organizationId, ...remaining.map((r) => r.id)];
    await Promise.allSettled(touched.map((id) => this.applyAllProjectsForOrg(id)));
    return { quotaGroupId: null };
  }

  async updateOrgCaps(
    organizationId: string,
    data: Partial<Caps> & {
      defaultPodCpuMilli?: number | null;
      defaultPodMemoryBytes?: number | null;
      maxProjects?: number | null;
      maxEnvironments?: number | null;
      maxDeployments?: number | null;
    }
  ) {
    assertPositiveOrBlank({
      'CPU cap': data.cpuLimitMilli,
      'Memory cap': data.memoryLimitBytes,
      'Max pods': data.maxPods,
      'Max services': data.maxServices,
      'Default CPU': data.defaultPodCpuMilli,
      'Default memory': data.defaultPodMemoryBytes,
      'Project limit': data.maxProjects,
      'Environment limit': data.maxEnvironments,
      'Deployment limit': data.maxDeployments
    });
    const self = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { quotaGroupId: true }
    });
    if (!self) throw new NotFoundException('Organization not found');

    const update = {
      ...(data.cpuLimitMilli !== undefined && { cpuLimitMilli: data.cpuLimitMilli }),
      ...(data.memoryLimitBytes !== undefined && {
        memoryLimitBytes: data.memoryLimitBytes === null ? null : BigInt(data.memoryLimitBytes)
      }),
      ...(data.maxPods !== undefined && { maxPods: data.maxPods }),
      ...(data.maxServices !== undefined && { maxServices: data.maxServices }),
      ...(data.maxProjects !== undefined && { maxProjects: data.maxProjects }),
      ...(data.maxEnvironments !== undefined && { maxEnvironments: data.maxEnvironments }),
      ...(data.maxDeployments !== undefined && { maxDeployments: data.maxDeployments }),
      ...(data.defaultPodCpuMilli !== undefined && { defaultPodCpuMilli: data.defaultPodCpuMilli }),
      ...(data.defaultPodMemoryBytes !== undefined && {
        defaultPodMemoryBytes:
          data.defaultPodMemoryBytes === null ? null : BigInt(data.defaultPodMemoryBytes)
      })
    };

    // Connected orgs share one set of caps: mirror the change across the group.
    const targetIds = self.quotaGroupId
      ? (
          await this.prisma.organization.findMany({
            where: { quotaGroupId: self.quotaGroupId },
            select: { id: true }
          })
        ).map((o) => o.id)
      : [organizationId];

    await this.prisma.organization.updateMany({
      where: { id: { in: targetIds } },
      data: update
    });
    await Promise.allSettled(targetIds.map((id) => this.applyAllProjectsForOrg(id)));
    return this.prisma.organization.findUnique({ where: { id: organizationId } });
  }

  async updateProjectCaps(projectId: string, data: Partial<Caps>) {
    assertPositiveOrBlank({
      'CPU cap': data.cpuLimitMilli,
      'Memory cap': data.memoryLimitBytes,
      'Max pods': data.maxPods,
      'Max services': data.maxServices
    });
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(data.cpuLimitMilli !== undefined && { cpuLimitMilli: data.cpuLimitMilli }),
        ...(data.memoryLimitBytes !== undefined && {
          memoryLimitBytes: data.memoryLimitBytes === null ? null : BigInt(data.memoryLimitBytes)
        }),
        ...(data.maxPods !== undefined && { maxPods: data.maxPods }),
        ...(data.maxServices !== undefined && { maxServices: data.maxServices })
      }
    });
    await this.applyProjectQuota(projectId);
    return project;
  }

  // Resolved allowance for a member. Null = unlimited on that axis.
  async resolveMemberAllowance(
    organizationId: string,
    userId: string
  ): Promise<{
    cpuMilli: number | null;
    memoryBytes: number | null;
    source: {
      cpu: 'explicit' | 'default' | 'unlimited';
      memory: 'explicit' | 'default' | 'unlimited';
    };
  }> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: {
        cpuAllowanceMilli: true,
        memoryAllowanceBytes: true,
        cpuAllowanceUnlimited: true,
        memoryAllowanceUnlimited: true,
        organization: {
          select: {
            defaultMemberCpuMilli: true,
            defaultMemberMemoryBytes: true
          }
        }
      }
    });
    if (!member) {
      return { cpuMilli: 0, memoryBytes: 0, source: { cpu: 'explicit', memory: 'explicit' } };
    }
    return memberAllowance(member, member.organization);
  }

  async resolveOwnerAllowance(
    organizationId: string,
    ownerId: string
  ): Promise<{ cpuMilli: number | null; memoryBytes: number | null }> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: ownerId } },
      select: { userId: true }
    });
    if (member) return this.resolveMemberAllowance(organizationId, ownerId);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { defaultMemberCpuMilli: true, defaultMemberMemoryBytes: true }
    });
    return ownerLeftAllowance(org);
  }

  // Sum requested resources for everything owned by this user inside this org.
  async getMemberUsage(
    organizationId: string,
    userId: string,
    excludeDeploymentId?: string
  ): Promise<{
    cpuMilli: number;
    memoryBytes: number;
    breakdown: {
      kind: 'deployment' | 'database' | 'templateInstance';
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      cpuMilli: number;
      memoryBytes: number;
      replicas: number;
    }[];
  }> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId, ownerId: userId },
      select: OWNED_PROJECT_SELECT
    });
    return ownedUsage(projects, excludeDeploymentId);
  }

  // Throws if `ownerId`'s allowance would be exceeded by adding `requested`.
  async enforceMemberAllowanceForNewPod(
    organizationId: string,
    ownerId: string | null | undefined,
    requested: { cpuMilli: number; memoryBytes: number },
    excludeDeploymentId?: string
  ) {
    if (!ownerId) return;
    if (await this.limitsOff()) return;
    const allowance = await this.resolveOwnerAllowance(organizationId, ownerId);
    if (allowance.cpuMilli === null && allowance.memoryBytes === null) return;
    const usage = await this.getMemberUsage(organizationId, ownerId, excludeDeploymentId);
    if (allowance.cpuMilli !== null && usage.cpuMilli + requested.cpuMilli > allowance.cpuMilli) {
      throw new ForbiddenException(
        `User CPU allowance exceeded: need ${usage.cpuMilli + requested.cpuMilli}m, allowance ${allowance.cpuMilli}m`
      );
    }
    if (
      allowance.memoryBytes !== null &&
      usage.memoryBytes + requested.memoryBytes > allowance.memoryBytes
    ) {
      throw new ForbiddenException(
        `User memory allowance exceeded: need ${formatBytes(usage.memoryBytes + requested.memoryBytes)}, allowance ${formatBytes(allowance.memoryBytes)}`
      );
    }
  }

  private async runningOnOtherMode(mode: ResourceLimitsMode) {
    const apps = await (mode === 'off'
      ? this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM k8s_objects o
          WHERE o.kind = 'Deployment'
            AND o.deployment_id IS NOT NULL
            AND COALESCE((o.manifest #>> '{spec,replicas}')::int, 1) > 0
            AND COALESCE(o.manifest #> '{spec,template,spec,containers,0,resources,limits}', '{}'::jsonb) <> '{}'::jsonb`
      : this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM k8s_objects o
          JOIN deployments d ON d.id = o.deployment_id
          WHERE o.kind = 'Deployment'
            AND NOT (d.cpu_request_milli IS NOT DISTINCT FROM 0 AND COALESCE(d.memory_request_bytes, 0) = 0)
            AND COALESCE((o.manifest #>> '{spec,replicas}')::int, 1) > 0
            AND COALESCE(o.manifest #> '{spec,template,spec,containers,0,resources,limits}', '{}'::jsonb) = '{}'::jsonb`);
    const databases = await (mode === 'off'
      ? this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM k8s_objects o
          WHERE o.kind = 'Cluster'
            AND o.database_id IS NOT NULL
            AND COALESCE(o.manifest #>> '{metadata,annotations,cnpg.io/hibernation}', '') <> 'on'
            AND COALESCE(o.manifest #> '{spec,resources,limits}', '{}'::jsonb) <> '{}'::jsonb`
      : this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM k8s_objects o
          WHERE o.kind = 'Cluster'
            AND o.database_id IS NOT NULL
            AND COALESCE(o.manifest #>> '{metadata,annotations,cnpg.io/hibernation}', '') <> 'on'
            AND COALESCE(o.manifest #> '{spec,resources,limits}', '{}'::jsonb) = '{}'::jsonb`);
    return { apps: apps[0]?.count ?? 0, databases: databases[0]?.count ?? 0 };
  }

  async resourceLimitsView() {
    const state = await this.settings.getResourceLimitsState();
    const chosen = state.dbValue !== null || state.envOverride !== null;
    const withoutOwnLimits = {
      OR: [{ cpuRequestMilli: null }, { memoryRequestBytes: null }]
    };
    const [apps, databases, appsAffected, databasesAffected, organizations, stale] =
      await Promise.all([
        this.prisma.deployment.count(),
        this.prisma.database.count(),
        this.prisma.deployment.count({ where: withoutOwnLimits }),
        this.prisma.database.count({ where: withoutOwnLimits }),
        this.prisma.organization.findMany({
          select: {
            id: true,
            name: true,
            slug: true,
            defaultPodCpuMilli: true,
            defaultPodMemoryBytes: true
          },
          orderBy: { name: 'asc' }
        }),
        chosen
          ? this.runningOnOtherMode(state.value).catch((err) => {
              this.logger.warn(`couldn't count workloads: ${err?.message ?? err}`);
              return null;
            })
          : Promise.resolve({ apps: 0, databases: 0 })
      ]);
    return {
      value: state.value,
      dbValue: state.dbValue,
      envOverride: state.envOverride,
      newInstance: apps === 0 && databases === 0,
      affected: { apps: appsAffected, databases: databasesAffected },
      stale,
      fallback: podDefaultsFor({ defaultPodCpuMilli: null, defaultPodMemoryBytes: null }),
      organizations: organizations.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        defaultPodCpuMilli: org.defaultPodCpuMilli || null,
        defaultPodMemoryBytes: org.defaultPodMemoryBytes ? Number(org.defaultPodMemoryBytes) : null
      }))
    };
  }

  // Everything a single project currently requests, with the same
  // replica arithmetic getMemberUsage applies to an owner's whole portfolio.
  async getProjectRequestedResources(
    projectId: string
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        deployments: {
          select: { cpuRequestMilli: true, memoryRequestBytes: true, replicas: true, stopped: true }
        },
        databases: { select: { cpuRequestMilli: true, memoryRequestBytes: true, replicas: true } }
      }
    });
    if (!project) return { cpuMilli: 0, memoryBytes: 0 };
    let cpu = 0;
    let mem = 0;
    for (const row of project.deployments) {
      const instances = row.stopped ? 0 : Math.max(1, row.replicas ?? 1);
      cpu += (row.cpuRequestMilli ?? 0) * instances;
      mem += (row.memoryRequestBytes ? Number(row.memoryRequestBytes) : 0) * instances;
    }
    for (const row of project.databases) {
      const instances = Math.max(1, row.replicas ?? 1);
      cpu += (row.cpuRequestMilli ?? 0) * instances;
      mem += (row.memoryRequestBytes ? Number(row.memoryRequestBytes) : 0) * instances;
    }
    return { cpuMilli: cpu, memoryBytes: mem };
  }

  // Throws if handing `projectId` to `newOwnerId` would push them past their
  // allowance. Ownership is what getMemberUsage sums over, so a transfer moves
  // the project's entire request from one member's budget onto another's in
  // one step: far bigger than any single deploy, and never checked anywhere
  // else. Caller must reject a no-op transfer first: if `newOwnerId` already
  // owns the project, getMemberUsage already counts it and this double-counts.
  async enforceMemberAllowanceForProjectTransfer(
    organizationId: string,
    newOwnerId: string,
    projectId: string
  ) {
    if (await this.limitsOff()) return;
    const allowance = await this.resolveMemberAllowance(organizationId, newOwnerId);
    if (allowance.cpuMilli === null && allowance.memoryBytes === null) return;
    const requested = await this.getProjectRequestedResources(projectId);
    const usage = await this.getMemberUsage(organizationId, newOwnerId);
    if (allowance.cpuMilli !== null && usage.cpuMilli + requested.cpuMilli > allowance.cpuMilli) {
      throw new ForbiddenException(
        `Transfer would exceed the new owner's CPU allowance: need ${usage.cpuMilli + requested.cpuMilli}m, allowance ${allowance.cpuMilli}m`
      );
    }
    if (
      allowance.memoryBytes !== null &&
      usage.memoryBytes + requested.memoryBytes > allowance.memoryBytes
    ) {
      throw new ForbiddenException(
        `Transfer would exceed the new owner's memory allowance: need ${formatBytes(usage.memoryBytes + requested.memoryBytes)}, allowance ${formatBytes(allowance.memoryBytes)}`
      );
    }
  }

  // Sum of all members' effective allowance: used to validate that admins don't oversell the org.
  // `Unlimited` members contribute 0 to the sum (they don't reserve a share).
  // Pass overrides to compute as if a specific member or default were changed.
  private async computeOrgAllowanceCommitment(
    organizationId: string,
    overrides?: {
      memberOverride?: {
        userId: string;
        cpuMilli: number | null;
        memoryBytes: number | null;
        cpuUnlimited: boolean;
        memoryUnlimited: boolean;
      };
      defaultOverride?: {
        cpuMilli: number | null;
        memoryBytes: number | null;
      };
    }
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        defaultMemberCpuMilli: true,
        defaultMemberMemoryBytes: true,
        members: {
          select: {
            userId: true,
            cpuAllowanceMilli: true,
            memoryAllowanceBytes: true,
            cpuAllowanceUnlimited: true,
            memoryAllowanceUnlimited: true
          }
        }
      }
    });
    if (!org) throw new NotFoundException('Organization not found');
    return allowanceCommitment(org, overrides);
  }

  async setMemberAllowance(
    organizationId: string,
    userId: string,
    data: {
      cpuMilli?: number | null; // null = inherit default
      memoryBytes?: number | null;
      cpuUnlimited?: boolean;
      memoryUnlimited?: boolean;
    }
  ) {
    assertPositiveOrBlank({ 'CPU allowance': data.cpuMilli, 'Memory allowance': data.memoryBytes });
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } }
    });
    if (!member) throw new NotFoundException('Member not found');

    let nextMemoryBytes: number | null = member.memoryAllowanceBytes
      ? Number(member.memoryAllowanceBytes)
      : null;
    if (data.memoryBytes !== undefined) {
      nextMemoryBytes = data.memoryBytes;
    }

    const next = {
      cpuMilli: data.cpuMilli !== undefined ? data.cpuMilli : member.cpuAllowanceMilli,
      memoryBytes: nextMemoryBytes,
      cpuUnlimited:
        data.cpuUnlimited !== undefined ? data.cpuUnlimited : member.cpuAllowanceUnlimited,
      memoryUnlimited:
        data.memoryUnlimited !== undefined ? data.memoryUnlimited : member.memoryAllowanceUnlimited
    };

    return this.prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: {
        cpuAllowanceMilli: next.cpuUnlimited ? null : next.cpuMilli,
        memoryAllowanceBytes:
          next.memoryUnlimited || next.memoryBytes === null ? null : BigInt(next.memoryBytes),
        cpuAllowanceUnlimited: next.cpuUnlimited,
        memoryAllowanceUnlimited: next.memoryUnlimited
      }
    });
  }

  async setOrgDefaultMemberAllowance(
    organizationId: string,
    data: { cpuMilli?: number | null; memoryBytes?: number | null }
  ) {
    assertPositiveOrBlank({ 'CPU allowance': data.cpuMilli, 'Memory allowance': data.memoryBytes });
    return this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(data.cpuMilli !== undefined && { defaultMemberCpuMilli: data.cpuMilli }),
        ...(data.memoryBytes !== undefined && {
          defaultMemberMemoryBytes: data.memoryBytes === null ? null : BigInt(data.memoryBytes)
        })
      }
    });
  }

  async getOrgMembersUsage(organizationId: string) {
    const [org, owned] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          cpuLimitMilli: true,
          memoryLimitBytes: true,
          defaultMemberCpuMilli: true,
          defaultMemberMemoryBytes: true,
          members: {
            select: {
              userId: true,
              role: true,
              cpuAllowanceMilli: true,
              memoryAllowanceBytes: true,
              cpuAllowanceUnlimited: true,
              memoryAllowanceUnlimited: true,
              user: {
                select: {
                  id: true,
                  username: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  imageUrl: true
                }
              }
            }
          }
        }
      }),
      this.prisma.project.findMany({
        where: { organizationId, ownerId: { not: null } },
        select: { ownerId: true, ...OWNED_PROJECT_SELECT }
      })
    ]);
    if (!org) throw new NotFoundException('Organization not found');
    const byOwner = groupByOwner(owned);
    const rows = org.members.map((m) => {
      const allowance = memberAllowance(m, org);
      const usage = ownedUsage(byOwner.get(m.userId) ?? []);
      return {
        user: m.user,
        role: m.role,
        allowance: {
          cpuMilli: allowance.cpuMilli,
          memoryBytes: allowance.memoryBytes,
          source: allowance.source
        },
        usage: { cpuMilli: usage.cpuMilli, memoryBytes: usage.memoryBytes }
      };
    });
    return {
      org: {
        cpuLimitMilli: org.cpuLimitMilli || null,
        memoryLimitBytes: org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null,
        defaultMemberCpuMilli: org.defaultMemberCpuMilli,
        defaultMemberMemoryBytes: org.defaultMemberMemoryBytes
          ? Number(org.defaultMemberMemoryBytes)
          : null
      },
      commitment: allowanceCommitment(org),
      members: rows
    };
  }

  async listProjectCapsForOrg(organizationId: string) {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        namespace: true,
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true,
        maxServices: true
      },
      orderBy: { name: 'asc' }
    });
    const namespaces = projects.map((p) => p.namespace);
    const [usage, pods] = await Promise.all([
      this.k8sNamespace.getOrgUsage(namespaces, VIEW_SNAPSHOT),
      this.k8s.getClusterPodUsage(VIEW_SNAPSHOT)
    ]);
    const perNs = new Map<string, { cpuMilli: number; memoryBytes: number; pods: number }>();
    for (const p of pods) {
      if (!p.namespace) continue;
      const cur = perNs.get(p.namespace) || { cpuMilli: 0, memoryBytes: 0, pods: 0 };
      cur.cpuMilli += p.cpuLimitMilli;
      cur.memoryBytes += p.memoryLimitBytes;
      cur.pods += 1;
      perNs.set(p.namespace, cur);
    }
    return {
      orgTotal: usage,
      projects: projects.map((p) => ({
        ...p,
        cpuLimitMilli: p.cpuLimitMilli || null,
        memoryLimitBytes: p.memoryLimitBytes ? Number(p.memoryLimitBytes) : null,
        maxPods: p.maxPods || null,
        maxServices: p.maxServices || null,
        usage: perNs.get(p.namespace) || { cpuMilli: 0, memoryBytes: 0, pods: 0 }
      }))
    };
  }
}
