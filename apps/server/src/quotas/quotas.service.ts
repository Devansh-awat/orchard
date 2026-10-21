import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { defaultPodResourcesForImage, minPodMemoryBytesForImage } from '../kubernetes/presets';
import { formatBytes } from '../projects/projects.utils';
import { ownerLeftAllowance } from './owner-allowance';

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

@Injectable()
export class QuotasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
    private readonly k8sNamespace: K8sNamespaceService
  ) {}

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
    const fallback = defaultPodResourcesForImage(image);
    const cpu = override?.cpuRequestMilli ?? defaultPodCpuMilli ?? fallback.cpuMilli;
    const mem = override?.memoryRequestBytes ?? defaultPodMemoryBytes ?? fallback.memoryBytes;
    // Floor applies to the explicit override too: a user asking for 128Mi of
    // Postgres is asking for a database that OOMKills itself during its backup.
    return { cpuMilli: cpu, memoryBytes: Math.max(mem, minPodMemoryBytesForImage(image)) };
  }

  // Push the effective caps for a project to Kubernetes (ResourceQuota + LimitRange).
  async applyProjectQuota(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    if (!project) return;
    const { caps, defaultPodCpuMilli, defaultPodMemoryBytes } =
      await this.resolveProjectCaps(projectId);
    // RollingUpdate briefly runs old and new pods side by side (maxSurge 25%),
    // so the namespace ResourceQuota gets matching headroom on top of the cap —
    // otherwise a namespace running at its cap can never replace a pod: the
    // surge pod is rejected at admission and the rollout wedges. Steady-state
    // usage is still held to the real cap by the API-layer checks
    // (enforceOrgCapForNewPod / member allowances).
    const SURGE_HEADROOM = 1.25;
    const withHeadroom = (v: number | null) => (v ? Math.ceil(v * SURGE_HEADROOM) : v);
    const podsWithHeadroom = caps.maxPods
      ? caps.maxPods + Math.max(1, Math.ceil(caps.maxPods * 0.25))
      : caps.maxPods;
    // Each environment has its own namespace; push the project's cap as the
    // per-namespace ceiling to every one of them (real per-org/member totals
    // are still held by the API-layer aggregation). Union the legacy project
    // namespace in case an environment row is missing (belt and suspenders).
    const namespaces = new Set<string>([
      project.namespace,
      ...project.environments.map((e) => e.namespace)
    ]);
    await Promise.allSettled(
      Array.from(namespaces).map((namespace) =>
        this.k8sNamespace.applyNamespaceQuota({
          namespace,
          cpuLimitMilli: withHeadroom(caps.cpuLimitMilli),
          memoryLimitBytes: withHeadroom(caps.memoryLimitBytes),
          maxPods: podsWithHeadroom,
          maxServices: caps.maxServices,
          defaultPodCpuMilli,
          defaultPodMemoryBytes
        })
      )
    );
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
  // Linked orgs share both the cap and the usage pool — total usage is summed across them.
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
  // the org past its org-wide cap. Additive resources only — cpu/memory.
  async enforceOrgCapForNewPod(
    organizationId: string,
    requested: { cpuMilli: number; memoryBytes: number }
  ) {
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

  /** Org total resource usage — lightweight, no caps/metadata. */
  async getOrgTotalUsage(
    organizationId: string,
    namespaces: string[]
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    if (namespaces.length === 0) return { cpuMilli: 0, memoryBytes: 0 };
    const usage = await this.k8sNamespace.getOrgUsage(namespaces);
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
        defaultPodCpuMilli: true,
        defaultPodMemoryBytes: true,
        quotaGroupId: true
      }
    });
    if (!org) throw new NotFoundException('Org not found');
    const namespaces = await this.getQuotaGroupNamespaces(organizationId);
    const usage = await this.k8sNamespace.getOrgUsage(namespaces);
    const connections = await this.getOrgConnections(organizationId);
    return {
      org: {
        id: org.id,
        name: org.name,
        cpuLimitMilli: org.cpuLimitMilli,
        memoryLimitBytes: org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null,
        maxPods: org.maxPods,
        maxServices: org.maxServices,
        defaultPodCpuMilli: org.defaultPodCpuMilli,
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
      throw new ForbiddenException('Cannot connect an organization to itself');
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
    if (!primary) throw new NotFoundException('Primary org not found');
    if (!other) throw new NotFoundException('Other org not found');

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
    }
  ) {
    const self = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { quotaGroupId: true }
    });
    if (!self) throw new NotFoundException('Org not found');

    const update = {
      ...(data.cpuLimitMilli !== undefined && { cpuLimitMilli: data.cpuLimitMilli }),
      ...(data.memoryLimitBytes !== undefined && {
        memoryLimitBytes: data.memoryLimitBytes === null ? null : BigInt(data.memoryLimitBytes)
      }),
      ...(data.maxPods !== undefined && { maxPods: data.maxPods }),
      ...(data.maxServices !== undefined && { maxServices: data.maxServices }),
      ...(data.defaultPodCpuMilli !== undefined && { defaultPodCpuMilli: data.defaultPodCpuMilli }),
      ...(data.defaultPodMemoryBytes !== undefined && {
        defaultPodMemoryBytes:
          data.defaultPodMemoryBytes === null ? null : BigInt(data.defaultPodMemoryBytes)
      })
    };

    // Connected orgs share one set of caps — mirror the change across the group.
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

  // --- Per-member allowance ---

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
      // Non-members get no allowance — but in practice this isn't called for non-members.
      return { cpuMilli: 0, memoryBytes: 0, source: { cpu: 'explicit', memory: 'explicit' } };
    }
    let cpu: number | null;
    let cpuSource: 'explicit' | 'default' | 'unlimited';
    if (member.cpuAllowanceUnlimited) {
      cpu = null;
      cpuSource = 'unlimited';
    } else if (member.cpuAllowanceMilli !== null) {
      cpu = member.cpuAllowanceMilli;
      cpuSource = 'explicit';
    } else if (member.organization.defaultMemberCpuMilli !== null) {
      cpu = member.organization.defaultMemberCpuMilli;
      cpuSource = 'default';
    } else {
      cpu = null;
      cpuSource = 'unlimited';
    }
    let mem: number | null;
    let memSource: 'explicit' | 'default' | 'unlimited';
    if (member.memoryAllowanceUnlimited) {
      mem = null;
      memSource = 'unlimited';
    } else if (member.memoryAllowanceBytes !== null) {
      mem = Number(member.memoryAllowanceBytes);
      memSource = 'explicit';
    } else if (member.organization.defaultMemberMemoryBytes !== null) {
      mem = Number(member.organization.defaultMemberMemoryBytes);
      memSource = 'default';
    } else {
      mem = null;
      memSource = 'unlimited';
    }
    return { cpuMilli: cpu, memoryBytes: mem, source: { cpu: cpuSource, memory: memSource } };
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
      select: {
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
        },
        templateInstances: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    let cpu = 0;
    let mem = 0;
    const breakdown: {
      kind: 'deployment' | 'database' | 'templateInstance';
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      cpuMilli: number;
      memoryBytes: number;
      replicas: number;
    }[] = [];
    for (const p of projects) {
      for (const d of p.deployments) {
        if (excludeDeploymentId && d.id === excludeDeploymentId) continue;
        const replicas = d.stopped ? 0 : (d.replicas ?? 1);
        const c = (d.cpuRequestMilli ?? 0) * replicas;
        const m = (d.memoryRequestBytes ? Number(d.memoryRequestBytes) : 0) * replicas;
        cpu += c;
        mem += m;
        breakdown.push({
          kind: 'deployment',
          id: d.id,
          name: d.name,
          projectId: p.id,
          projectName: p.name,
          cpuMilli: c,
          memoryBytes: m,
          replicas
        });
      }
      for (const db of p.databases) {
        // A CNPG cluster runs `replicas` instances, each a full pod at the
        // configured size — same arithmetic as a scaled deployment.
        const instances = Math.max(1, db.replicas ?? 1);
        const c = (db.cpuRequestMilli ?? 0) * instances;
        const m = (db.memoryRequestBytes ? Number(db.memoryRequestBytes) : 0) * instances;
        cpu += c;
        mem += m;
        breakdown.push({
          kind: 'database',
          id: db.id,
          name: db.name,
          projectId: p.id,
          projectName: p.name,
          cpuMilli: c,
          memoryBytes: m,
          replicas: instances
        });
      }
    }
    return { cpuMilli: cpu, memoryBytes: mem, breakdown };
  }

  // Throws if `ownerId`'s allowance would be exceeded by adding `requested`.
  async enforceMemberAllowanceForNewPod(
    organizationId: string,
    ownerId: string | null | undefined,
    requested: { cpuMilli: number; memoryBytes: number },
    excludeDeploymentId?: string
  ) {
    if (!ownerId) return;
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
  // one step — far bigger than any single deploy, and never checked anywhere
  // else. Caller must reject a no-op transfer first: if `newOwnerId` already
  // owns the project, getMemberUsage already counts it and this double-counts.
  async enforceMemberAllowanceForProjectTransfer(
    organizationId: string,
    newOwnerId: string,
    projectId: string
  ) {
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

  // Sum of all members' effective allowance — used to validate that admins don't oversell the org.
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
    if (!org) throw new NotFoundException('Org not found');
    const defaultCpu =
      overrides?.defaultOverride?.cpuMilli !== undefined
        ? overrides.defaultOverride.cpuMilli
        : org.defaultMemberCpuMilli;
    let defaultMem: number | null = org.defaultMemberMemoryBytes
      ? Number(org.defaultMemberMemoryBytes)
      : null;
    if (overrides?.defaultOverride?.memoryBytes !== undefined) {
      defaultMem = overrides.defaultOverride.memoryBytes;
    }
    let cpu = 0;
    let mem = 0;
    for (const m of org.members) {
      const override =
        overrides?.memberOverride?.userId === m.userId ? overrides.memberOverride : null;
      const cpuUnlimited = override ? override.cpuUnlimited : m.cpuAllowanceUnlimited;
      const memUnlimited = override ? override.memoryUnlimited : m.memoryAllowanceUnlimited;
      const cpuExplicit = override ? override.cpuMilli : m.cpuAllowanceMilli;
      let memExplicit: number | null = null;
      if (override) memExplicit = override.memoryBytes;
      else if (m.memoryAllowanceBytes) memExplicit = Number(m.memoryAllowanceBytes);
      if (!cpuUnlimited) {
        if (cpuExplicit !== null) cpu += cpuExplicit;
        else if (defaultCpu !== null) cpu += defaultCpu;
      }
      if (!memUnlimited) {
        if (memExplicit !== null) mem += memExplicit;
        else if (defaultMem !== null) mem += defaultMem;
      }
    }
    return { cpuMilli: cpu, memoryBytes: mem };
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

  // Table for the org admin view at /[org]/usage.
  async getOrgMembersUsage(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
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
    });
    if (!org) throw new NotFoundException('Org not found');
    const rows = await Promise.all(
      org.members.map(async (m) => {
        const allowance = await this.resolveMemberAllowance(organizationId, m.userId);
        const usage = await this.getMemberUsage(organizationId, m.userId);
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
      })
    );
    const commitment = await this.computeOrgAllowanceCommitment(organizationId);
    return {
      org: {
        cpuLimitMilli: org.cpuLimitMilli,
        memoryLimitBytes: org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null,
        defaultMemberCpuMilli: org.defaultMemberCpuMilli,
        defaultMemberMemoryBytes: org.defaultMemberMemoryBytes
          ? Number(org.defaultMemberMemoryBytes)
          : null
      },
      commitment,
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
    const usage = await this.k8sNamespace.getOrgUsage(namespaces); // aggregate; we also want per-ns
    // Fetch per-ns breakdown cheaply: reuse getClusterPodUsage
    const pods = await this.k8s.getClusterPodUsage();
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
        memoryLimitBytes: p.memoryLimitBytes ? Number(p.memoryLimitBytes) : null,
        usage: perNs.get(p.namespace) || { cpuMilli: 0, memoryBytes: 0, pods: 0 }
      }))
    };
  }
}
