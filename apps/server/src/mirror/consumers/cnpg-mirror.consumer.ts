import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';
import { latestTermination } from './pod-mirror.consumer';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const EMIT_COALESCE_MS = 250;
const FRESH_TRANSITION_MS = 10 * 60 * 1000;

interface Ctx {
  databaseId: string;
  orgId: string;
  projectId: string;
}

interface PendingEmit {
  ctx: Ctx;
  payload: unknown;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class CnpgMirrorConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(CnpgMirrorConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly archivingState = new Map<string, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleDestroy() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async mapPodRefs(pod: k8s.V1Pod): Promise<MirrorRefs> {
    const ns = pod.metadata?.namespace;
    const clusterName = pod.metadata?.labels?.['cnpg.io/cluster'];
    if (!ns || !clusterName) return {};
    const ctx = await this.resolveCtx(ns, clusterName);
    return ctx ? { databaseId: ctx.databaseId, projectId: ctx.projectId } : {};
  }

  async mapClusterRefs(cluster: any): Promise<MirrorRefs> {
    const ns = cluster.metadata?.namespace;
    const name = cluster.metadata?.name;
    if (!ns || !name) return {};
    const ctx = await this.resolveCtx(ns, name);
    return ctx ? { databaseId: ctx.databaseId, projectId: ctx.projectId } : {};
  }

  async onPodEvent(type: MirrorEventType, pod: k8s.V1Pod): Promise<void> {
    const ns = pod.metadata?.namespace;
    const clusterName = pod.metadata?.labels?.['cnpg.io/cluster'];
    if (!ns || !clusterName) return;
    const ctx = await this.resolveCtx(ns, clusterName);
    if (!ctx) return;

    this.scheduleEmit(ctx, this.buildPodPayload(type, pod));
  }

  async onClusterEvent(type: MirrorEventType, cluster: any): Promise<void> {
    const ns = cluster.metadata?.namespace;
    const name = cluster.metadata?.name;
    if (!ns || !name) return;
    const ctx = await this.resolveCtx(ns, name);
    if (!ctx) return;

    if (type === 'delete') {
      this.archivingState.delete(`${ns}/${name}`);
      await this.writebackStatus(ctx, { deleted: true });
      return;
    }

    await this.trackArchiving(ctx, ns, name, cluster);
    await this.writebackStatus(ctx, { cluster });
  }

  private async writebackStatus(ctx: Ctx, input: { cluster?: any; deleted?: boolean }): Promise<void> {
    try {
      const db = await this.prisma.database.findUnique({
        where: { id: ctx.databaseId },
        select: { status: true },
      });
      if (!db) return;

      let next = db.status;
      if (input.deleted) {
        if (db.status !== 'error' && db.status !== 'provisioning' && db.status !== 'deleting') {
          next = 'error';
        }
      } else {
        const status = input.cluster?.status ?? {};
        const readyInstances: number = status.readyInstances || 0;
        const instances: number = status.instances || input.cluster?.spec?.instances || 1;
        const ready = readyInstances >= instances && readyInstances > 0;
        if (ready && db.status !== 'ready' && db.status !== 'restoring') {
          next = 'ready';
        }
      }

      if (next !== db.status) {
        await this.prisma.database.update({ where: { id: ctx.databaseId }, data: { status: next } });
      }
    } catch (err) {
      this.logger.warn(`writebackStatus(${ctx.databaseId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async trackArchiving(ctx: Ctx, ns: string, name: string, cluster: any): Promise<void> {
    const cond = (cluster.status?.conditions || []).find(
      (c: any) => c.type === 'ContinuousArchiving',
    );
    if (!cond) return;
    const ok = cond.status === 'True';
    const key = `${ns}/${name}`;
    const prev = this.archivingState.get(key);
    this.archivingState.set(key, ok);
    if (prev === ok) return;
    if (prev === undefined) {
      const t = cond.lastTransitionTime ? Date.parse(cond.lastTransitionTime) : NaN;
      const fresh = !Number.isNaN(t) && Date.now() - t < FRESH_TRANSITION_MS;
      if (ok || !fresh) return;
    }
    this.scheduleEmit(ctx, { archiving: ok });
    await this.notifications
      .notifyDbArchiving(ctx.databaseId, ok ? 'recovered' : 'failing', cond.message || undefined)
      .catch(() => {});
  }

  private scheduleEmit(ctx: Ctx, payload: unknown) {
    const key = ctx.databaseId;
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
      type: 'database.changed',
      id: ctx.databaseId,
      projectId: ctx.projectId,
      payload,
    });
  }

  private buildPodPayload(type: MirrorEventType, pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (type === 'delete') return { deleted: true, pod: name };
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const term = latestTermination(containerStatuses);
    return {
      pod: name,
      phase: pod.status?.phase ?? null,
      ready:
        pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
      restartCount: containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
      lastTermination: term?.reason
        ? { reason: term.reason, exitCode: term.exitCode, finishedAt: term.finishedAt }
        : null,
    };
  }

  private async resolveCtx(ns: string, clusterName: string): Promise<Ctx | null> {
    const key = `${ns}/${clusterName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    let ctx: Ctx | null = null;
    try {
      const db = await this.prisma.database.findFirst({
        where: { namespace: ns, clusterName },
        select: {
          id: true,
          projectId: true,
          project: { select: { organizationId: true } },
        },
      });
      if (db) {
        ctx = { databaseId: db.id, orgId: db.project.organizationId, projectId: db.projectId };
      }
    } catch (err) {
      this.logger.warn(`resolveCtx(${key}) failed: ${(err as Error)?.message ?? err}`);
      return null;
    }

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}
