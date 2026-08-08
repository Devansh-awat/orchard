import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 500;

interface Ctx {
  deploymentId: string;
  orgId: string;
  projectId: string;
}

interface PendingEmit {
  ctx: Ctx;
  payload: unknown;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class WorkloadMirrorConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(WorkloadMirrorConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
  ) {}

  onModuleDestroy() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async mapRefs(dep: k8s.V1Deployment): Promise<MirrorRefs> {
    const ctx = await this.resolveCtx(dep);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  async onEvent(type: MirrorEventType, dep: k8s.V1Deployment): Promise<void> {
    const ctx = await this.resolveCtx(dep);
    if (!ctx) return;

    try {
      if (type === 'delete') {
        await this.prisma.k8sWorkload.deleteMany({ where: { deploymentId: ctx.deploymentId } });
        this.scheduleEmit(ctx, { workload: null, deleted: true });
        return;
      }

      const specReplicas = dep.spec?.replicas ?? null;
      const data = {
        specReplicas,
        readyReplicas: dep.status?.readyReplicas ?? 0,
        availableReplicas: dep.status?.availableReplicas ?? 0,
        updatedReplicas: dep.status?.updatedReplicas ?? 0,
        observedImage: dep.spec?.template?.spec?.containers?.[0]?.image ?? null,
        conditions: (dep.status?.conditions ?? []) as object[],
      };

      const existing = await this.prisma.k8sWorkload.findUnique({
        where: { deploymentId: ctx.deploymentId },
      });
      await this.prisma.k8sWorkload.upsert({
        where: { deploymentId: ctx.deploymentId },
        create: { deploymentId: ctx.deploymentId, ...data },
        update: data,
      });

      await this.adoptReplicas(ctx.deploymentId, specReplicas);

      const changed =
        !existing ||
        existing.specReplicas !== data.specReplicas ||
        existing.readyReplicas !== data.readyReplicas ||
        existing.availableReplicas !== data.availableReplicas ||
        existing.updatedReplicas !== data.updatedReplicas ||
        existing.observedImage !== data.observedImage;
      if (changed) {
        this.scheduleEmit(ctx, { workload: data });
      }
    } catch (err) {
      this.logger.warn(
        `workload sync(${ctx.deploymentId}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async adoptReplicas(deploymentId: string, specReplicas: number | null): Promise<void> {
    if (specReplicas == null) return;
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { replicas: true, buildStatus: true },
    });
    if (!dep || dep.replicas === specReplicas) return;
    if (dep.buildStatus === 'building') return;
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { replicas: specReplicas },
    });
    this.logger.log(`adopted external scale for ${deploymentId}: replicas=${specReplicas}`);
  }

  private scheduleEmit(ctx: Ctx, payload: unknown) {
    const key = ctx.deploymentId;
    const now = Date.now();
    const last = this.lastEmit.get(key) ?? 0;

    if (now - last >= EMIT_COALESCE_MS) {
      this.lastEmit.set(key, now);
      this.emit(ctx, payload);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.payload = payload;
      return;
    }
    const delay = EMIT_COALESCE_MS - (now - last);
    const timer = setTimeout(() => {
      const p = this.pending.get(key);
      this.pending.delete(key);
      this.lastEmit.set(key, Date.now());
      if (p) this.emit(p.ctx, p.payload);
    }, delay);
    this.pending.set(key, { ctx, payload, timer });
  }

  private emit(ctx: Ctx, payload: unknown) {
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'deployment.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload,
    });
  }

  private async resolveCtx(dep: k8s.V1Deployment): Promise<Ctx | null> {
    const ns = dep.metadata?.namespace;
    const name = dep.metadata?.name;
    if (!ns || !name) return null;
    const key = `${ns}/${name}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    let ctx: Ctx | null = null;
    try {
      const row = await this.prisma.deployment.findFirst({
        where: { namespace: ns, name },
        select: {
          id: true,
          projectId: true,
          project: { select: { organizationId: true } },
        },
      });
      if (row) {
        ctx = { deploymentId: row.id, orgId: row.project.organizationId, projectId: row.projectId };
      }
    } catch (err) {
      this.logger.warn(`resolveCtx(${key}) failed: ${(err as Error)?.message ?? err}`);
      return null;
    }

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}
