import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, NodePoolAffinityMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SELECTOR_OPERATORS = new Set(['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Lt']);
const TOLERATION_OPERATORS = new Set(['Exists', 'Equal']);
const TAINT_EFFECTS = new Set(['NoSchedule', 'PreferNoSchedule', 'NoExecute']);

export interface NodePoolInput {
  name?: string;
  description?: string | null;
  nodeSelector?: unknown;
  tolerations?: unknown;
  affinityMode?: NodePoolAffinityMode;
  userSelectable?: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Validate a nodeSelector as an array of k8s matchExpressions.
function validateNodeSelector(raw: unknown): Prisma.InputJsonValue {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('nodeSelector must be an array of match expressions');
  for (const expr of raw) {
    if (!expr || typeof expr !== 'object') throw new BadRequestException('Invalid nodeSelector expression');
    const e = expr as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key) throw new BadRequestException('nodeSelector expression needs a key');
    if (typeof e.operator !== 'string' || !SELECTOR_OPERATORS.has(e.operator)) {
      throw new BadRequestException(`nodeSelector operator must be one of ${[...SELECTOR_OPERATORS].join(', ')}`);
    }
    if (e.values != null && !Array.isArray(e.values)) throw new BadRequestException('nodeSelector values must be an array');
  }
  return raw as Prisma.InputJsonValue;
}

// Validate tolerations as an array of k8s tolerations.
function validateTolerations(raw: unknown): Prisma.InputJsonValue {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('tolerations must be an array');
  for (const tol of raw) {
    if (!tol || typeof tol !== 'object') throw new BadRequestException('Invalid toleration');
    const t = tol as Record<string, unknown>;
    if (t.operator != null && (typeof t.operator !== 'string' || !TOLERATION_OPERATORS.has(t.operator))) {
      throw new BadRequestException('toleration operator must be Exists or Equal');
    }
    if (t.effect != null && (typeof t.effect !== 'string' || !TAINT_EFFECTS.has(t.effect))) {
      throw new BadRequestException(`toleration effect must be one of ${[...TAINT_EFFECTS].join(', ')}`);
    }
    if (t.key != null && typeof t.key !== 'string') throw new BadRequestException('toleration key must be a string');
  }
  return raw as Prisma.InputJsonValue;
}

@Injectable()
export class NodePoolsService {
  constructor(private readonly prisma: PrismaService) {}

  // Full detail for superadmins, including how many workloads reference each pool.
  async list() {
    return this.prisma.nodePool.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { deployments: true, jobs: true, databases: true } } },
    });
  }

  // Trimmed, safe projection for tenants — friendly names only, no raw
  // selectors/taints. Only pools the superadmin opted into userspace.
  async listSelectable() {
    return this.prisma.nodePool.findMany({
      where: { userSelectable: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, description: true },
    });
  }

  async get(id: string) {
    const pool = await this.prisma.nodePool.findUnique({
      where: { id },
      include: { _count: { select: { deployments: true, jobs: true, databases: true } } },
    });
    if (!pool) throw new NotFoundException('Node pool not found');
    return pool;
  }

  async create(input: NodePoolInput) {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    const slug = slugify(name);
    if (!slug) throw new BadRequestException('name must contain alphanumeric characters');
    const existing = await this.prisma.nodePool.findUnique({ where: { slug } });
    if (existing) throw new BadRequestException(`A node pool with slug "${slug}" already exists`);
    return this.prisma.nodePool.create({
      data: {
        name,
        slug,
        description: input.description ?? null,
        nodeSelector: validateNodeSelector(input.nodeSelector),
        tolerations: validateTolerations(input.tolerations),
        affinityMode: input.affinityMode ?? 'preferred',
        userSelectable: input.userSelectable ?? false,
      },
    });
  }

  async update(id: string, input: NodePoolInput) {
    const pool = await this.prisma.nodePool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('Node pool not found');
    const data: Prisma.NodePoolUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      data.name = name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.nodeSelector !== undefined) data.nodeSelector = validateNodeSelector(input.nodeSelector);
    if (input.tolerations !== undefined) data.tolerations = validateTolerations(input.tolerations);
    if (input.affinityMode !== undefined) data.affinityMode = input.affinityMode;
    if (input.userSelectable !== undefined) data.userSelectable = input.userSelectable;
    return this.prisma.nodePool.update({ where: { id }, data });
  }

  async remove(id: string) {
    const pool = await this.prisma.nodePool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('Node pool not found');
    // Workload FKs are onDelete: SetNull, so assigned workloads simply revert
    // to default scheduling on their next deploy.
    await this.prisma.nodePool.delete({ where: { id } });
    return { success: true };
  }
}
