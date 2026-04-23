import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { parseCpu, parseMemory } from '../kubernetes/quantity';
import { DEFAULT_CPU_MILLI, DEFAULT_MEMORY_BYTES } from '../kubernetes/presets';

export type Caps = {
  cpuLimitMilli: number | null;
  memoryLimitBytes: number | null;
  maxPods: number | null;
  maxServices: number | null;
};

type EffectiveProjectCaps = Caps & {
  source: { cpu: 'project' | 'org' | null; memory: 'project' | 'org' | null; pods: 'project' | 'org' | null; services: 'project' | 'org' | null };
};

@Injectable()
export class QuotasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
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
            defaultPodMemoryBytes: true,
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const pick = <T>(a: T | null, b: T | null): { value: T | null; source: 'project' | 'org' | null } => {
      if (a !== null && a !== undefined) return { value: a, source: 'project' };
      if (b !== null && b !== undefined) return { value: b, source: 'org' };
      return { value: null, source: null };
    };

    const cpu = pick(project.cpuLimitMilli, project.organization.cpuLimitMilli);
    const mem = pick(
      project.memoryLimitBytes ? Number(project.memoryLimitBytes) : null,
      project.organization.memoryLimitBytes ? Number(project.organization.memoryLimitBytes) : null,
    );
    const pods = pick(project.maxPods, project.organization.maxPods);
    const svcs = pick(project.maxServices, project.organization.maxServices);

    return {
      caps: {
        cpuLimitMilli: cpu.value,
        memoryLimitBytes: mem.value,
        maxPods: pods.value,
        maxServices: svcs.value,
        source: { cpu: cpu.source, memory: mem.source, pods: pods.source, services: svcs.source },
      },
      defaultPodCpuMilli: project.organization.defaultPodCpuMilli,
      defaultPodMemoryBytes: project.organization.defaultPodMemoryBytes
        ? Number(project.organization.defaultPodMemoryBytes)
        : null,
    };
  }

  // Resolve the per-pod resources for a deployment/db/template resource.
  // Precedence: explicit override on the resource → org default → hardcoded fallback.
  async resolvePodResources(
    projectId: string,
    override?: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
  ): Promise<{ cpuMilli: number; memoryBytes: number }> {
    const { defaultPodCpuMilli, defaultPodMemoryBytes } = await this.resolveProjectCaps(projectId);
    const cpu =
      override?.cpuRequestMilli ??
      defaultPodCpuMilli ??
      DEFAULT_CPU_MILLI;
    const mem =
      override?.memoryRequestBytes ??
      defaultPodMemoryBytes ??
      DEFAULT_MEMORY_BYTES;
    return { cpuMilli: cpu, memoryBytes: mem };
  }

  // Push the effective caps for a project to Kubernetes (ResourceQuota + LimitRange).
  async applyProjectQuota(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { namespace: true },
    });
    if (!project) return;
    const { caps, defaultPodCpuMilli, defaultPodMemoryBytes } = await this.resolveProjectCaps(projectId);
    await this.k8s.applyNamespaceQuota({
      namespace: project.namespace,
      cpuLimitMilli: caps.cpuLimitMilli,
      memoryLimitBytes: caps.memoryLimitBytes,
      maxPods: caps.maxPods,
      maxServices: caps.maxServices,
      defaultPodCpuMilli,
      defaultPodMemoryBytes,
    });
  }

  // Reapply quotas to every project in an org (after org-level caps change).
  async applyAllProjectsForOrg(organizationId: string) {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: { id: true },
    });
    for (const p of projects) {
      await this.applyProjectQuota(p.id).catch((err) => {
        console.error(`[Quotas] Failed to apply quota for project ${p.id}:`, err);
      });
    }
  }

  // Org-wide admission check used at deploy time. Throws if the requested delta would push
  // the org past its org-wide cap. Additive resources only — cpu/memory.
  async enforceOrgCapForNewPod(
    organizationId: string,
    requested: { cpuMilli: number; memoryBytes: number },
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        cpuLimitMilli: true,
        memoryLimitBytes: true,
        maxPods: true,
        projects: { select: { namespace: true } },
      },
    });
    if (!org) return;
    const capCpu = org.cpuLimitMilli;
    const capMem = org.memoryLimitBytes ? Number(org.memoryLimitBytes) : null;
    const capPods = org.maxPods;
    if (!capCpu && !capMem && !capPods) return;
    const namespaces = org.projects.map((p) => p.namespace);
    const usage = await this.k8s.getOrgUsage(namespaces);

    if (capCpu && usage.cpuMilli + requested.cpuMilli > capCpu) {
      throw new ForbiddenException(
        `Organization CPU quota exceeded: need ${usage.cpuMilli + requested.cpuMilli}m, limit ${capCpu}m`,
      );
    }
    if (capMem && usage.memoryBytes + requested.memoryBytes > capMem) {
      throw new ForbiddenException(
        `Organization memory quota exceeded: need ${usage.memoryBytes + requested.memoryBytes}B, limit ${capMem}B`,
      );
    }
    if (capPods && usage.pods + 1 > capPods) {
      throw new ForbiddenException(
        `Organization pod count quota exceeded: ${usage.pods}/${capPods}`,
      );
    }
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
        projects: { select: { namespace: true } },
      },
    });
    if (!org) throw new NotFoundException('Org not found');
    const usage = await this.k8s.getOrgUsage(org.projects.map((p) => p.namespace));
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
      },
      usage,
    };
  }

  async updateOrgCaps(organizationId: string, data: Partial<Caps> & {
    defaultPodCpuMilli?: number | null;
    defaultPodMemoryBytes?: number | null;
  }) {
    const org = await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(data.cpuLimitMilli !== undefined && { cpuLimitMilli: data.cpuLimitMilli }),
        ...(data.memoryLimitBytes !== undefined && {
          memoryLimitBytes: data.memoryLimitBytes === null ? null : BigInt(data.memoryLimitBytes),
        }),
        ...(data.maxPods !== undefined && { maxPods: data.maxPods }),
        ...(data.maxServices !== undefined && { maxServices: data.maxServices }),
        ...(data.defaultPodCpuMilli !== undefined && { defaultPodCpuMilli: data.defaultPodCpuMilli }),
        ...(data.defaultPodMemoryBytes !== undefined && {
          defaultPodMemoryBytes:
            data.defaultPodMemoryBytes === null ? null : BigInt(data.defaultPodMemoryBytes),
        }),
      },
    });
    await this.applyAllProjectsForOrg(organizationId);
    return org;
  }

  async updateProjectCaps(projectId: string, data: Partial<Caps>) {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(data.cpuLimitMilli !== undefined && { cpuLimitMilli: data.cpuLimitMilli }),
        ...(data.memoryLimitBytes !== undefined && {
          memoryLimitBytes: data.memoryLimitBytes === null ? null : BigInt(data.memoryLimitBytes),
        }),
        ...(data.maxPods !== undefined && { maxPods: data.maxPods }),
        ...(data.maxServices !== undefined && { maxServices: data.maxServices }),
      },
    });
    await this.applyProjectQuota(projectId);
    return project;
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
        maxServices: true,
      },
      orderBy: { name: 'asc' },
    });
    const namespaces = projects.map((p) => p.namespace);
    const usage = await this.k8s.getOrgUsage(namespaces); // aggregate; we also want per-ns
    // Fetch per-ns breakdown cheaply: reuse getClusterPodUsage
    const pods = await this.k8s.getClusterPodUsage();
    const perNs = new Map<string, { cpuMilli: number; memoryBytes: number; pods: number }>();
    for (const p of pods) {
      if (!p.namespace) continue;
      const cur = perNs.get(p.namespace) || { cpuMilli: 0, memoryBytes: 0, pods: 0 };
      cur.cpuMilli += p.cpuRequestMilli;
      cur.memoryBytes += p.memoryRequestBytes;
      cur.pods += 1;
      perNs.set(p.namespace, cur);
    }
    return {
      orgTotal: usage,
      projects: projects.map((p) => ({
        ...p,
        memoryLimitBytes: p.memoryLimitBytes ? Number(p.memoryLimitBytes) : null,
        usage: perNs.get(p.namespace) || { cpuMilli: 0, memoryBytes: 0, pods: 0 },
      })),
    };
  }
}
