import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MirrorEventType, MirrorObjectKey, MirrorRefs } from '../mirror-informer';
import { latestTermination } from './pod-mirror.consumer';
import { computePodStatus } from '../pod-status';
import { PodLogCaptureService } from '../../kubernetes/pod-log-capture.service';
import { K8sCnpgService } from '../../kubernetes/k8s-cnpg.service';
import { clusterSnapshot } from '../../kubernetes/cnpg-status';
import { storagePressure, storagePressureDetail } from '../../kubernetes/db-stats';
import { dataVolumesOf, fullestVolume, nextStorageSize } from '../../kubernetes/volume-stats';
import { ProjectsService } from '../../projects/projects.service';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const EMIT_COALESCE_MS = 250;
const FRESH_TRANSITION_MS = 10 * 60 * 1000;
const CRASH_CONFIRM_MS = 30_000;
const RECOVER_CONFIRM_MS = 60_000;
const STATS_MIN_GAP_MS = 10 * 1000;
const AUTO_EXPAND_MIN_GAP_MS = 15 * 60 * 1000;

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

  private readonly storageState = new Map<string, boolean>();

  private readonly lastSample = new Map<string, number>();

  private readonly sampling = new Set<string>();

  private readonly lastAutoExpand = new Map<string, number>();

  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly notifications: NotificationsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly cnpg: K8sCnpgService,
    private readonly moduleRef: ModuleRef
  ) {}

  onModuleDestroy() {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async pruneStalePods(seen: MirrorObjectKey[]): Promise<void> {
    if (seen.some((s) => s.refs === null)) {
      this.logger.warn('skipping database pod prune: this pass could not resolve every pod');
      return;
    }
    const liveIds: string[] = [];
    const liveNames: string[] = [];
    for (const key of seen) {
      const databaseId = key.refs?.databaseId;
      if (!databaseId || !key.name) continue;
      liveIds.push(databaseId);
      liveNames.push(key.name);
    }
    const removed = await this.prisma.$queryRaw<{ database_id: string }[]>`
      DELETE FROM "database_pods" AS p
      WHERE NOT EXISTS (
        SELECT 1
        FROM unnest(${liveIds}::uuid[], ${liveNames}::varchar[])
          AS live("database_id", "name")
        WHERE live."database_id" = p."database_id" AND live."name" = p."name"
      )
      RETURNING p."database_id"
    `;
    if (removed.length === 0) return;
    this.logger.log(`pruned ${removed.length} stale database pod rows not present in the cluster`);
    for (const databaseId of new Set(removed.map((r) => r.database_id))) {
      await this.reconcileCrashState(databaseId);
    }
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

    const statusChanged = await this.syncPod(type, ctx.databaseId, pod);
    if (statusChanged) await this.reconcileCrashState(ctx.databaseId);

    if (type !== 'delete') {
      void this.logCapture.capture(ctx.databaseId, ns, pod, 'database');
      if (isReadyPrimary(pod)) void this.sampleStats(ctx, pod.metadata!.name!, ns);
    }

    this.scheduleEmit(ctx, this.buildPodPayload(type, pod));
  }

  private async syncPod(type: MirrorEventType, databaseId: string, pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (!name) return false;
    const existing = await this.prisma.databasePod.findUnique({
      where: { databaseId_name: { databaseId, name } },
      select: { status: true }
    });
    if (type === 'delete') {
      if (!existing) return false;
      await this.prisma.databasePod.deleteMany({ where: { databaseId, name } });
      return true;
    }
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const term = latestTermination(containerStatuses);
    const status = computePodStatus(pod);
    const data = {
      podIp: pod.status?.podIP ?? null,
      nodeName: pod.spec?.nodeName ?? null,
      status,
      restartCount: containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
      ready: pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? null,
      lastTerminationReason: term?.reason ?? null,
      lastExitCode: term?.exitCode ?? null,
      lastTerminatedAt: term?.finishedAt ?? null,
      currentPrimary: pod.metadata?.labels?.['cnpg.io/instanceRole'] === 'primary'
    };
    await this.prisma.databasePod.upsert({
      where: { databaseId_name: { databaseId, name } },
      create: { databaseId, name, ...data },
      update: data
    });
    return !existing || existing.status !== status;
  }

  async reconcileCrashState(databaseId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const [crashing, total] = await this.prisma.$transaction([
        this.prisma.databasePod.count({ where: { databaseId, status: 'crashing' } }),
        this.prisma.databasePod.count({ where: { databaseId } })
      ]);
      await this.applyCrashState(databaseId, crashing, total);
    } catch (err) {
      this.logger.warn(
        `reconcileCrashState(${databaseId}) failed: ${(err as Error)?.message ?? err}`
      );
    }
  }

  private async applyCrashState(databaseId: string, crashingPods: number, totalPods: number) {
    const state = await this.prisma.databaseCrashState.findUnique({ where: { databaseId } });
    const now = new Date();

    if (crashingPods > 0) {
      if (!state || !state.crashingSince) {
        await this.prisma.databaseCrashState.upsert({
          where: { databaseId },
          create: { databaseId, crashingSince: now, healthySince: null, notifiedAt: null },
          update: { crashingSince: now, healthySince: null, notifiedAt: null }
        });
        return;
      }
      if (state.healthySince) {
        await this.prisma.databaseCrashState.updateMany({
          where: { databaseId },
          data: { healthySince: null }
        });
      }
      if (state.notifiedAt) return;
      if (now.getTime() - state.crashingSince.getTime() < CRASH_CONFIRM_MS) return;
      const claimed = await this.prisma.databaseCrashState.updateMany({
        where: { databaseId, notifiedAt: null },
        data: { notifiedAt: now }
      });
      if (claimed.count === 0) return;
      const pod = await this.prisma.databasePod.findFirst({
        where: { databaseId, status: 'crashing' },
        select: { lastTerminationReason: true, lastExitCode: true }
      });
      const detail = pod?.lastTerminationReason
        ? `${pod.lastTerminationReason}${pod.lastExitCode != null ? ` (exit code ${pod.lastExitCode})` : ''}`
        : undefined;
      await this.notifications.notifyDbState(databaseId, 'crashing', detail);
      return;
    }

    if (!state) return;
    if (!state.healthySince) {
      await this.prisma.databaseCrashState.updateMany({
        where: { databaseId },
        data: { healthySince: now, crashingSince: state.notifiedAt ? state.crashingSince : null }
      });
      return;
    }
    if (now.getTime() - state.healthySince.getTime() < RECOVER_CONFIRM_MS) return;
    if (!state.notifiedAt) {
      await this.prisma.databaseCrashState.deleteMany({ where: { databaseId, notifiedAt: null } });
      return;
    }
    const claimed = await this.prisma.databaseCrashState.deleteMany({
      where: { databaseId, notifiedAt: { not: null } }
    });
    if (claimed.count === 0) return;
    if (totalPods > 0) await this.notifications.notifyDbState(databaseId, 'recovered');
  }

  async sweepCrashStates(): Promise<void> {
    if (this.stopped) return;
    try {
      const [tracked, crashing] = await this.prisma.$transaction([
        this.prisma.databaseCrashState.findMany({ select: { databaseId: true } }),
        this.prisma.databasePod.findMany({
          where: { status: 'crashing' },
          select: { databaseId: true },
          distinct: ['databaseId']
        })
      ]);
      const ids = new Set([
        ...tracked.map((t) => t.databaseId),
        ...crashing.map((c) => c.databaseId)
      ]);
      for (const id of ids) await this.reconcileCrashState(id);
    } catch (err) {
      this.logger.warn(`database crash sweep failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async rebuildPodRows(): Promise<{ synced: number; changed: number }> {
    if (this.stopped) return { synced: 0, changed: 0 };
    const objects = await this.prisma.k8sObject.findMany({
      where: { shard: 'cnpg', kind: 'Pod', databaseId: { not: null } },
      select: { databaseId: true, manifest: true }
    });
    const touched = new Set<string>();
    let synced = 0;
    for (const obj of objects) {
      const databaseId = obj.databaseId!;
      try {
        const changed = await this.syncPod('update', databaseId, obj.manifest as k8s.V1Pod);
        synced += 1;
        if (changed) touched.add(databaseId);
      } catch (err) {
        this.logger.warn(`rebuildPodRows(${databaseId}) failed: ${(err as Error)?.message ?? err}`);
      }
    }
    for (const databaseId of touched) await this.reconcileCrashState(databaseId);
    if (touched.size > 0) {
      this.logger.log(
        `database pod rows rebuilt: ${synced} synced, ${touched.size} databases changed`
      );
    }
    return { synced, changed: touched.size };
  }

  async sweepVolumes(): Promise<{ sampled: number; expanded: number } | null> {
    if (this.stopped) return null;
    const { usage, nodesFailed } = await this.cnpg.listVolumeUsage();
    if (usage.size === 0) {
      if (nodesFailed > 0) this.logger.warn('volume sweep skipped: no node answered');
      return null;
    }
    const databases = await this.prisma.database.findMany({
      where: { mode: 'cnpg', namespace: { not: null }, clusterName: { not: null } },
      select: {
        id: true,
        namespace: true,
        clusterName: true,
        storageSize: true,
        status: true,
        projectId: true,
        walPendingSegments: true,
        project: { select: { organizationId: true } }
      }
    });
    let sampled = 0;
    let expanded = 0;
    for (const db of databases) {
      const volume = fullestVolume(dataVolumesOf(usage, db.namespace!, db.clusterName!));
      if (!volume) continue;
      sampled += 1;
      const ctx: Ctx = {
        databaseId: db.id,
        orgId: db.project.organizationId,
        projectId: db.projectId
      };
      try {
        await this.prisma.database.update({
          where: { id: db.id },
          data: {
            volumeUsedBytes: BigInt(Math.round(volume.usedBytes)),
            volumeCapacityBytes: BigInt(Math.round(volume.capacityBytes))
          }
        });
        await this.trackStorage(ctx, {
          volumeUsedBytes: volume.usedBytes,
          volumeCapacityBytes: volume.capacityBytes,
          walPendingSegments: db.walPendingSegments
        });
        if (await this.maybeAutoExpand(db, volume.usedBytes, volume.capacityBytes)) expanded += 1;
      } catch (err) {
        this.logger.warn(
          `volume sweep for ${db.namespace}/${db.clusterName} failed: ${(err as Error)?.message ?? err}`
        );
      }
    }
    if (expanded > 0) this.logger.log(`volume sweep: ${sampled} sampled, ${expanded} expanded`);
    return { sampled, expanded };
  }

  private async maybeAutoExpand(
    db: {
      id: string;
      namespace: string | null;
      clusterName: string | null;
      storageSize: string | null;
      status: string;
    },
    usedBytes: number,
    capacityBytes: number
  ): Promise<boolean> {
    const target = nextStorageSize(db.storageSize, usedBytes, capacityBytes);
    if (!target) return false;
    const last = this.lastAutoExpand.get(db.id) ?? 0;
    if (Date.now() - last < AUTO_EXPAND_MIN_GAP_MS) return false;
    this.lastAutoExpand.set(db.id, Date.now());
    const projects = this.moduleRef.get(ProjectsService, { strict: false });
    const from = db.storageSize ?? `${Math.round(capacityBytes / 1024 ** 3)}Gi`;
    const fillPercent = Math.round((usedBytes / capacityBytes) * 100);
    this.logger.warn(
      `[DB/storage] ${db.namespace}/${db.clusterName} is ${fillPercent}% full at ${from}, expanding to ${target}`
    );
    await projects.expandDatabaseStorage(db.id, target);
    await this.notifications
      .notifyDbStorageExpanded(db.id, from, target, fillPercent)
      .catch(() => {});
    return true;
  }

  async sampleAllStats(): Promise<void> {
    if (this.stopped) return;
    try {
      const primaries = await this.prisma.databasePod.findMany({
        where: { currentPrimary: true, ready: true },
        select: {
          name: true,
          database: {
            select: {
              id: true,
              namespace: true,
              projectId: true,
              project: { select: { organizationId: true } }
            }
          }
        }
      });
      for (const p of primaries) {
        if (!p.database.namespace) continue;
        await this.sampleStats(
          {
            databaseId: p.database.id,
            orgId: p.database.project.organizationId,
            projectId: p.database.projectId
          },
          p.name,
          p.database.namespace
        );
      }
    } catch (err) {
      this.logger.warn(`database stats sweep failed: ${(err as Error)?.message ?? err}`);
    }
  }

  async sampleStats(ctx: Ctx, pod: string, namespace: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastSample.get(ctx.databaseId) ?? 0) < STATS_MIN_GAP_MS) return;
    if (this.sampling.has(ctx.databaseId)) return;
    this.sampling.add(ctx.databaseId);
    try {
      const db = await this.prisma.database.findUnique({
        where: { id: ctx.databaseId },
        select: { dbName: true }
      });
      if (!db) return;
      const stats = await this.cnpg.sampleDatabaseStats(namespace, pod, db.dbName);
      if (!stats) return;
      this.lastSample.set(ctx.databaseId, Date.now());
      await this.prisma.database.update({
        where: { id: ctx.databaseId },
        data: {
          sizeBytes: BigInt(Math.round(stats.sizeBytes)),
          connections: stats.connections,
          statsAt: new Date(),
          volumeUsedBytes:
            stats.volumeUsedBytes == null ? null : BigInt(Math.round(stats.volumeUsedBytes)),
          volumeCapacityBytes:
            stats.volumeCapacityBytes == null
              ? null
              : BigInt(Math.round(stats.volumeCapacityBytes)),
          walPendingSegments: stats.walPendingSegments ?? null
        }
      });
      this.scheduleEmit(ctx, { stats: true });
      await this.trackStorage(ctx, stats);
    } catch (err) {
      this.logger.warn(`sampleStats(${ctx.databaseId}) failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.sampling.delete(ctx.databaseId);
    }
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
      await this.writebackSnapshot(ctx, { ...clusterSnapshot(cluster), exists: false });
      this.scheduleEmit(ctx, { cluster: 'deleted' });
      return;
    }

    await this.trackArchiving(ctx, ns, name, cluster);
    await this.writebackStatus(ctx, { cluster });
    const snapshot = clusterSnapshot(cluster);
    await this.writebackSnapshot(ctx, snapshot);
    this.scheduleEmit(ctx, { cluster: snapshot.phase, readyInstances: snapshot.readyInstances });
  }

  private async writebackSnapshot(ctx: Ctx, snapshot: ReturnType<typeof clusterSnapshot>) {
    await this.prisma.database.update({
      where: { id: ctx.databaseId },
      data: { clusterStatus: snapshot as object, clusterSyncedAt: new Date() }
    });
  }

  // Failures propagate: the informer holds the cluster object's derived_version
  // back and replays it, which is the only thing that would ever come back for
  // a database whose status write was lost.
  private async writebackStatus(
    ctx: Ctx,
    input: { cluster?: any; deleted?: boolean }
  ): Promise<void> {
    const db = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: { status: true }
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
  }

  private async trackStorage(
    ctx: Ctx,
    stats: {
      volumeUsedBytes: number | null;
      volumeCapacityBytes: number | null;
      walPendingSegments: number | null;
    }
  ): Promise<void> {
    const prev = this.storageState.get(ctx.databaseId);
    const pressured = storagePressure(prev, stats);
    this.storageState.set(ctx.databaseId, pressured);
    if (prev === pressured || (prev === undefined && !pressured)) return;
    await this.notifications
      .notifyDbStorage(
        ctx.databaseId,
        pressured ? 'pressure' : 'recovered',
        pressured ? storagePressureDetail(stats) : undefined
      )
      .catch(() => {});
  }

  private async trackArchiving(ctx: Ctx, ns: string, name: string, cluster: any): Promise<void> {
    const cond = (cluster.status?.conditions || []).find(
      (c: any) => c.type === 'ContinuousArchiving'
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
      payload
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
        : null
    };
  }

  private async resolveCtx(ns: string, clusterName: string): Promise<Ctx | null> {
    const key = `${ns}/${clusterName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    // A lookup that throws is left to propagate: `null` means "no such
    // database", which callers store as an answer, and a database blip must not
    // be mistaken for one. Nothing is cached on that path either.
    const db = await this.prisma.database.findFirst({
      where: { namespace: ns, clusterName },
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    const ctx: Ctx | null = db
      ? { databaseId: db.id, orgId: db.project.organizationId, projectId: db.projectId }
      : null;

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}

function isReadyPrimary(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.labels?.['cnpg.io/instanceRole'] !== 'primary') return false;
  return pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
}
