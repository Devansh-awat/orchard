import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { parseCpu, parseMemory } from '../kubernetes/quantity';

interface AssignmentInput {
  mode?: 'allow' | 'deny';
  cpuLimit?: string | null;
  memoryLimit?: string | null;
  maxServices?: number | null;
}

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
  ) {}

  // Sync the Node table with the live cluster: upsert each, mark last_seen_at.
  async syncFromCluster() {
    const live = await this.k8s.listClusterNodes();
    const now = new Date();
    for (const n of live) {
      const name = n.metadata?.name;
      if (!name) continue;
      const labels = (n.metadata?.labels || {}) as Record<string, string>;
      const capacity = n.status?.capacity || {};
      const schedulable = !(n.spec?.unschedulable);
      await this.prisma.node.upsert({
        where: { name },
        create: {
          name,
          labels,
          schedulable,
          cpuCapacity: typeof capacity.cpu === 'string' ? capacity.cpu : undefined,
          memoryCapacity: typeof capacity.memory === 'string' ? capacity.memory : undefined,
          lastSeenAt: now,
        },
        update: {
          labels,
          schedulable,
          // Only overwrite capacity fields if admin hasn't explicitly set them.
          // Here we overwrite always — admin override lives in a separate concept if needed.
          cpuCapacity: typeof capacity.cpu === 'string' ? capacity.cpu : undefined,
          memoryCapacity: typeof capacity.memory === 'string' ? capacity.memory : undefined,
          lastSeenAt: now,
        },
      });
    }
    return { synced: live.length };
  }

  async listNodes() {
    // Auto-sync on list — small clusters, keeps UI fresh.
    await this.syncFromCluster().catch(() => {});
    const nodes = await this.prisma.node.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { assignments: true } },
      },
    });
    const usage = await this.k8s.getClusterPodUsage();
    const perNode = new Map<string, { cpuMilli: number; memBytes: number; pods: number }>();
    for (const p of usage) {
      if (!p.nodeName) continue;
      const cur = perNode.get(p.nodeName) || { cpuMilli: 0, memBytes: 0, pods: 0 };
      cur.cpuMilli += p.cpuRequestMilli;
      cur.memBytes += p.memoryRequestBytes;
      cur.pods += 1;
      perNode.set(p.nodeName, cur);
    }
    return nodes.map((n) => {
      const u = perNode.get(n.name) || { cpuMilli: 0, memBytes: 0, pods: 0 };
      return {
        ...n,
        usage: {
          cpuMilli: u.cpuMilli,
          memoryBytes: u.memBytes,
          pods: u.pods,
        },
      };
    });
  }

  async getNode(id: string) {
    const node = await this.prisma.node.findUnique({
      where: { id },
      include: {
        assignments: {
          include: {
            organization: { select: { id: true, name: true, slug: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!node) throw new NotFoundException('Node not found');

    const usage = await this.k8s.getClusterPodUsage();
    const onThisNode = usage.filter((p) => p.nodeName === node.name);
    // Aggregate per-org usage using the "leaf.project" or namespace label. Namespaces are per-project;
    // we join by project.namespace → project.organizationId.
    const namespaces = Array.from(new Set(onThisNode.map((p) => p.namespace)));
    const projects = namespaces.length
      ? await this.prisma.project.findMany({
          where: { namespace: { in: namespaces } },
          select: { namespace: true, organizationId: true },
        })
      : [];
    const nsToOrg = new Map(projects.map((p) => [p.namespace, p.organizationId]));
    const perOrg = new Map<string, { cpuMilli: number; memBytes: number; pods: number }>();
    for (const p of onThisNode) {
      const orgId = nsToOrg.get(p.namespace);
      if (!orgId) continue;
      const cur = perOrg.get(orgId) || { cpuMilli: 0, memBytes: 0, pods: 0 };
      cur.cpuMilli += p.cpuRequestMilli;
      cur.memBytes += p.memoryRequestBytes;
      cur.pods += 1;
      perOrg.set(orgId, cur);
    }

    return {
      ...node,
      usage: {
        cpuMilli: onThisNode.reduce((a, b) => a + b.cpuRequestMilli, 0),
        memoryBytes: onThisNode.reduce((a, b) => a + b.memoryRequestBytes, 0),
        pods: onThisNode.length,
      },
      perOrgUsage: Array.from(perOrg.entries()).map(([orgId, u]) => ({ orgId, ...u })),
    };
  }

  async updateNode(
    id: string,
    data: { schedulable?: boolean; notes?: string | null; cpuCapacity?: string | null; memoryCapacity?: string | null },
  ) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    return this.prisma.node.update({
      where: { id },
      data: {
        ...(data.schedulable !== undefined && { schedulable: data.schedulable }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.cpuCapacity !== undefined && { cpuCapacity: data.cpuCapacity }),
        ...(data.memoryCapacity !== undefined && { memoryCapacity: data.memoryCapacity }),
      },
    });
  }

  async upsertAssignment(nodeId: string, orgId: string, input: AssignmentInput) {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundException('Node not found');
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (input.cpuLimit && parseCpu(input.cpuLimit) <= 0) {
      throw new BadRequestException('Invalid cpuLimit');
    }
    if (input.memoryLimit && parseMemory(input.memoryLimit) <= 0) {
      throw new BadRequestException('Invalid memoryLimit');
    }

    return this.prisma.orgNodeAssignment.upsert({
      where: {
        organizationId_nodeId: { organizationId: orgId, nodeId },
      },
      create: {
        nodeId,
        organizationId: orgId,
        mode: input.mode ?? 'allow',
        cpuLimit: input.cpuLimit ?? null,
        memoryLimit: input.memoryLimit ?? null,
        maxServices: input.maxServices ?? null,
      },
      update: {
        ...(input.mode !== undefined && { mode: input.mode }),
        ...(input.cpuLimit !== undefined && { cpuLimit: input.cpuLimit }),
        ...(input.memoryLimit !== undefined && { memoryLimit: input.memoryLimit }),
        ...(input.maxServices !== undefined && { maxServices: input.maxServices }),
      },
    });
  }

  async deleteAssignment(nodeId: string, orgId: string) {
    await this.prisma.orgNodeAssignment.deleteMany({
      where: { nodeId, organizationId: orgId },
    });
    return { success: true };
  }

  // Org-wide usage summary across the cluster.
  async getUsageSummary() {
    const usage = await this.k8s.getClusterPodUsage();
    const namespaces = Array.from(new Set(usage.map((p) => p.namespace)));
    const projects = namespaces.length
      ? await this.prisma.project.findMany({
          where: { namespace: { in: namespaces } },
          select: {
            namespace: true,
            organizationId: true,
            organization: { select: { id: true, name: true, slug: true, avatarUrl: true } },
          },
        })
      : [];
    const nsToOrg = new Map(projects.map((p) => [p.namespace, p.organization]));

    const perOrg = new Map<
      string,
      {
        org: { id: string; name: string; slug: string; avatarUrl: string | null };
        cpuMilli: number;
        memBytes: number;
        pods: number;
        byNode: Map<string, { cpuMilli: number; memBytes: number; pods: number }>;
      }
    >();
    for (const p of usage) {
      const org = nsToOrg.get(p.namespace);
      if (!org) continue;
      let bucket = perOrg.get(org.id);
      if (!bucket) {
        bucket = { org, cpuMilli: 0, memBytes: 0, pods: 0, byNode: new Map() };
        perOrg.set(org.id, bucket);
      }
      bucket.cpuMilli += p.cpuRequestMilli;
      bucket.memBytes += p.memoryRequestBytes;
      bucket.pods += 1;
      if (p.nodeName) {
        const cur = bucket.byNode.get(p.nodeName) || { cpuMilli: 0, memBytes: 0, pods: 0 };
        cur.cpuMilli += p.cpuRequestMilli;
        cur.memBytes += p.memoryRequestBytes;
        cur.pods += 1;
        bucket.byNode.set(p.nodeName, cur);
      }
    }

    return Array.from(perOrg.values()).map((b) => ({
      organization: b.org,
      cpuMilli: b.cpuMilli,
      memoryBytes: b.memBytes,
      pods: b.pods,
      byNode: Array.from(b.byNode.entries()).map(([name, u]) => ({ nodeName: name, ...u })),
    }));
  }

  // Enforcement helper used by projects/k8s deploy path.
  // Returns { allowedNodes: string[] | null, deniedNodes: string[] }.
  // allowedNodes === null means no restriction.
  async getPlacementForOrg(organizationId: string): Promise<{
    allowedNodes: string[] | null;
    deniedNodes: string[];
    quotas: { nodeName: string; cpuLimitMilli: number | null; memoryLimitBytes: number | null; maxServices: number | null }[];
  }> {
    const assignments = await this.prisma.orgNodeAssignment.findMany({
      where: { organizationId },
      include: { node: true },
    });
    const allows = assignments.filter((a) => a.mode === 'allow');
    const denies = assignments.filter((a) => a.mode === 'deny');
    return {
      allowedNodes: allows.length > 0 ? allows.map((a) => a.node.name) : null,
      deniedNodes: denies.map((a) => a.node.name),
      quotas: assignments.map((a) => ({
        nodeName: a.node.name,
        cpuLimitMilli: a.cpuLimit ? parseCpu(a.cpuLimit) : null,
        memoryLimitBytes: a.memoryLimit ? parseMemory(a.memoryLimit) : null,
        maxServices: a.maxServices,
      })),
    };
  }
}
