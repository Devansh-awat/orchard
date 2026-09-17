import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { AuthorizationService } from '../auth/authorization.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { parseCpu, parseMemory } from '../kubernetes/quantity';
import { mapNodeToRow, NodeTaint } from './node-mapping';
import type { PoolPlacement, PlacementOverride } from '../kubernetes/kubernetes.service';

const TAINT_EFFECTS = new Set(['NoSchedule', 'PreferNoSchedule', 'NoExecute']);

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
    private readonly authz: AuthorizationService,
    private readonly settings: InstanceSettingsService
  ) {}

  /**
   * Map the namespaces a set of pods live in to their owning organization.
   * Namespaces belong to a project directly or through one of its
   * environments; joining on Project.namespace alone drops every pod outside
   * the default environment out of the usage numbers.
   */
  private async namespaceOrgMap(namespaces: string[]) {
    type Org = { id: string; name: string; slug: string; avatarUrl: string | null };
    const nsToOrg = new Map<string, Org>();
    if (!namespaces.length) return nsToOrg;
    const orgSelect = { select: { id: true, name: true, slug: true, avatarUrl: true } };
    const [projects, environments] = await Promise.all([
      this.prisma.project.findMany({
        where: { namespace: { in: namespaces } },
        select: { namespace: true, organization: orgSelect }
      }),
      this.prisma.environment.findMany({
        where: { namespace: { in: namespaces } },
        select: { namespace: true, project: { select: { organization: orgSelect } } }
      })
    ]);
    for (const env of environments) nsToOrg.set(env.namespace, env.project.organization);
    for (const project of projects) nsToOrg.set(project.namespace, project.organization);
    return nsToOrg;
  }

  // Full reconcile against the live cluster. The node informer keeps the table
  // fresh in the steady state; this is the manual/forced-refresh path (and the
  // cold-start fallback when no informer is running).
  async syncFromCluster() {
    const live = await this.k8s.listClusterNodes();
    for (const n of live) {
      const row = mapNodeToRow(n);
      if (row) await this.upsertNodeRow(row, new Date());
    }
    return { synced: live.length };
  }

  // Upsert a single node snapshot. Shared with the node informer so live-watch
  // events and manual reconcile write identical rows. Capacity is always
  // overwritten from the cluster (measured); admin caps live in updateNode.
  async upsertNodeRow(row: ReturnType<typeof mapNodeToRow>, seenAt = new Date()) {
    if (!row) return;
    await this.prisma.node.upsert({
      where: { name: row.name },
      create: {
        name: row.name,
        labels: row.labels,
        taints: row.taints as unknown as Prisma.InputJsonValue,
        schedulable: row.schedulable,
        cpuCapacity: row.cpuCapacity,
        memoryCapacity: row.memoryCapacity,
        lastSeenAt: seenAt
      },
      update: {
        labels: row.labels,
        taints: row.taints as unknown as Prisma.InputJsonValue,
        schedulable: row.schedulable,
        cpuCapacity: row.cpuCapacity,
        memoryCapacity: row.memoryCapacity,
        lastSeenAt: seenAt
      }
    });
  }

  // A node object was removed from the cluster. Drop the row; its per-org
  // assignments cascade away (schema onDelete: Cascade).
  async removeNodeByName(name: string) {
    await this.prisma.node.deleteMany({ where: { name } });
  }

  async listNodes() {
    // Reads come straight from the DB — the node informer keeps it current.
    const nodes = await this.prisma.node.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { assignments: true } }
      }
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
          pods: u.pods
        }
      };
    });
  }

  async getNode(id: string) {
    const node = await this.prisma.node.findUnique({
      where: { id },
      include: {
        assignments: {
          include: {
            organization: { select: { id: true, name: true, slug: true, avatarUrl: true } }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!node) throw new NotFoundException('Node not found');

    const usage = await this.k8s.getClusterPodUsage();
    const onThisNode = usage.filter((p) => p.nodeName === node.name);
    // Aggregate per-org usage using the "leaf.project" or namespace label. Namespaces are per-project;
    // we join by project.namespace → project.organizationId.
    const namespaces = Array.from(new Set(onThisNode.map((p) => p.namespace)));
    const nsToOrg = await this.namespaceOrgMap(namespaces);
    const perOrg = new Map<string, { cpuMilli: number; memBytes: number; pods: number }>();
    for (const p of onThisNode) {
      const orgId = nsToOrg.get(p.namespace)?.id;
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
        pods: onThisNode.length
      },
      perOrgUsage: Array.from(perOrg.entries()).map(([orgId, u]) => ({ orgId, ...u }))
    };
  }

  async updateNode(
    id: string,
    data: {
      schedulable?: boolean;
      notes?: string | null;
      cpuCapacity?: string | null;
      memoryCapacity?: string | null;
    }
  ) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    return this.prisma.node.update({
      where: { id },
      data: {
        ...(data.schedulable !== undefined && { schedulable: data.schedulable }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.cpuCapacity !== undefined && { cpuCapacity: data.cpuCapacity }),
        ...(data.memoryCapacity !== undefined && { memoryCapacity: data.memoryCapacity })
      }
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
        organizationId_nodeId: { organizationId: orgId, nodeId }
      },
      create: {
        nodeId,
        organizationId: orgId,
        mode: input.mode ?? 'allow',
        cpuLimit: input.cpuLimit ?? null,
        memoryLimit: input.memoryLimit ?? null,
        maxServices: input.maxServices ?? null
      },
      update: {
        ...(input.mode !== undefined && { mode: input.mode }),
        ...(input.cpuLimit !== undefined && { cpuLimit: input.cpuLimit }),
        ...(input.memoryLimit !== undefined && { memoryLimit: input.memoryLimit }),
        ...(input.maxServices !== undefined && { maxServices: input.maxServices })
      }
    });
  }

  async deleteAssignment(nodeId: string, orgId: string) {
    await this.prisma.orgNodeAssignment.deleteMany({
      where: { nodeId, organizationId: orgId }
    });
    return { success: true };
  }

  // Org-wide usage summary across the cluster.
  async getUsageSummary() {
    const usage = await this.k8s.getClusterPodUsage();
    const namespaces = Array.from(new Set(usage.map((p) => p.namespace)));
    const nsToOrg = await this.namespaceOrgMap(namespaces);

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
      byNode: Array.from(b.byNode.entries()).map(([name, u]) => ({ nodeName: name, ...u }))
    }));
  }

  // Enforcement helper used by projects/k8s deploy path.
  // Returns { allowedNodes: string[] | null, deniedNodes: string[] }.
  // allowedNodes === null means no restriction.
  async getPlacementForOrg(organizationId: string): Promise<{
    allowedNodes: string[] | null;
    deniedNodes: string[];
    quotas: {
      nodeName: string;
      cpuLimitMilli: number | null;
      memoryLimitBytes: number | null;
      maxServices: number | null;
    }[];
  }> {
    const assignments = await this.prisma.orgNodeAssignment.findMany({
      where: { organizationId },
      include: { node: true }
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
        maxServices: a.maxServices
      }))
    };
  }

  // Resolve an assigned node pool into the placement primitives buildPlacement
  // consumes. Null pool id (or a deleted pool) yields null → no pool placement.
  async resolvePool(nodePoolId: string | null | undefined): Promise<PoolPlacement | null> {
    if (!nodePoolId) return null;
    const pool = await this.prisma.nodePool.findUnique({ where: { id: nodePoolId } });
    if (!pool) return null;
    return {
      nodeSelector: (pool.nodeSelector as unknown as PoolPlacement['nodeSelector']) ?? [],
      tolerations: (pool.tolerations as unknown as PoolPlacement['tolerations']) ?? [],
      affinityMode: pool.affinityMode
    };
  }

  // Normalize a stored placementOverride JSON blob into a typed override.
  toPlacementOverride(raw: unknown): PlacementOverride | null {
    if (!raw || typeof raw !== 'object') return null;
    return raw as PlacementOverride;
  }

  // Replace a node's taints (spec.taints). The informer reflects the result
  // back into the DB, so we don't dual-write the row here.
  async setNodeTaints(id: string, taints: NodeTaint[]) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    if (!Array.isArray(taints)) throw new BadRequestException('taints must be an array');
    const clean = taints.map((t) => {
      if (!t?.key) throw new BadRequestException('each taint needs a key');
      if (!t.effect || !TAINT_EFFECTS.has(t.effect)) {
        throw new BadRequestException(
          `taint effect must be one of ${[...TAINT_EFFECTS].join(', ')}`
        );
      }
      return { key: t.key, ...(t.value ? { value: t.value } : {}), effect: t.effect };
    });
    await this.k8s.patchNode(node.name, { spec: { taints: clean } });
    return { success: true };
  }

  // Merge-patch node labels. A null value removes that label key.
  async setNodeLabels(id: string, labels: Record<string, string | null>) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    if (!labels || typeof labels !== 'object')
      throw new BadRequestException('labels must be an object');
    await this.k8s.patchNode(node.name, { metadata: { labels } });
    return { success: true };
  }

  // Authorization gate for assigning a node pool / raw override to a workload.
  // Superadmins may set anything; tenants may only pick a userSelectable pool,
  // and only when the instance opted into userspace scheduling.
  async assertPoolAssignable(input: {
    nodePoolId?: string | null;
    placementOverride?: unknown;
    userId: string;
  }) {
    const { nodePoolId, placementOverride, userId } = input;
    if (await this.authz.isSuperAdmin(userId)) return;
    if (placementOverride != null) {
      throw new ForbiddenException('placementOverride can only be set by superadmins');
    }
    if (!nodePoolId) return;
    if (!(await this.settings.isUserspaceSchedulingEnabled())) {
      throw new ForbiddenException('Node pool selection is not enabled on this instance');
    }
    const pool = await this.prisma.nodePool.findUnique({
      where: { id: nodePoolId },
      select: { userSelectable: true }
    });
    if (!pool) throw new NotFoundException('Node pool not found');
    if (!pool.userSelectable) {
      throw new ForbiddenException('That node pool is not available for selection');
    }
  }
}
