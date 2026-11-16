import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { EngineEventType, EngineObjectKey, EngineRefs } from '../core/informer';
import { latestTermination } from './pod.consumer';
import { computePodStatus } from '../pod-status';
import { PodLogCaptureService } from '../../kubernetes/pod-log-capture.service';
import { cnpgScheduleName, K8sCnpgService } from '../../kubernetes/k8s-cnpg.service';
import { clusterSnapshot, WRITE_GUARD_ANNOTATION } from '../../kubernetes/cnpg-status';
import {
  nodeDiskPressure,
  storagePressure,
  storagePressureDetail,
  type StoragePressureInput
} from '../../kubernetes/db-stats';
import {
  dataVolumesOf,
  fullerOf,
  fullestVolume,
  writeGuardDecision,
  type DiskUsage
} from '../../kubernetes/volume-stats';
import { parseMemory } from '../../kubernetes/quantity';
import { DatabasesService } from '../../projects/databases.service';
import { DatabaseCheckpointsService } from '../../projects/database-checkpoints.service';
import { QuotasService } from '../../quotas/quotas.service';
import { AuditService } from '../../audit/audit.service';
import { K8S_DELETED_REASON } from './workload.consumer';
import {
  clusterSpecValues,
  hibernationTransition,
  planCompressionAdoption,
  planParameterAdoption,
  ResolvedResources,
  scheduleCronUpdate,
  specColumnUpdate
} from '../../kubernetes/cnpg-spec-sync';

const POSITIVE_TTL_MS = 30 * 1000;
const SETTINGS_LEAVES_ALONE = new Set(['deleting', 'provisioning', 'restoring']);
const NEGATIVE_TTL_MS = 60 * 1000;
const EMIT_COALESCE_MS = 250;
const FRESH_TRANSITION_MS = 10 * 60 * 1000;
const CRASH_CONFIRM_MS = 30_000;
const RECOVER_CONFIRM_MS = 60_000;
const STATS_MIN_GAP_MS = 10 * 1000;

const DATA_DIR_MEASURE_EVERY_MS = 5 * 60 * 1000;
const CONFIRM_AFTER_MS = 90 * 1000;
const SETTLING_STATUSES = new Set(['deleting', 'restoring', 'provisioning', 'error']);

type LiveState = 'present' | 'absent' | 'unknown';

export class ScheduleRemovalPending extends Error {}

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

function measuredAllowance(db: {
  storageSize: string | null;
  volumeUsedBytes: bigint | null;
  volumeCapacityBytes: bigint | null;
}): DiskUsage | null {
  const capacityBytes = parseMemory(db.storageSize ?? '');
  if (!(capacityBytes > 0) || db.volumeUsedBytes == null) return null;
  if (Number(db.volumeCapacityBytes) !== capacityBytes) return null;
  return { usedBytes: Number(db.volumeUsedBytes), capacityBytes };
}

@Injectable()
export class CnpgConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(CnpgConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly archivingState = new Map<string, boolean>();

  private readonly refusedSettings = new Map<string, string>();

  private readonly storageState = new Map<string, boolean>();

  private readonly lastSample = new Map<string, number>();

  private lastDataDirMeasure = new Map<string, number>();

  private readonly sampling = new Set<string>();

  private readonly scheduleAbsentSince = new Map<string, number>();

  protected confirmAfterMs = CONFIRM_AFTER_MS;

  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly notifications: NotificationsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly cnpg: K8sCnpgService,
    private readonly moduleRef: ModuleRef,
    private readonly audit: AuditService
  ) {}

  onModuleDestroy() {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async pruneStalePods(seen: EngineObjectKey[]): Promise<void> {
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

  async mapPodRefs(pod: k8s.V1Pod): Promise<EngineRefs> {
    const ns = pod.metadata?.namespace;
    const clusterName = pod.metadata?.labels?.['cnpg.io/cluster'];
    if (!ns || !clusterName) return {};
    const ctx = await this.resolveCtx(ns, clusterName);
    return ctx ? { databaseId: ctx.databaseId, projectId: ctx.projectId } : {};
  }

  async mapClusterRefs(cluster: any): Promise<EngineRefs> {
    const ns = cluster.metadata?.namespace;
    const name = cluster.metadata?.name;
    if (!ns || !name) return {};
    const ctx = await this.resolveCtx(ns, name, { fresh: true });
    return ctx ? { databaseId: ctx.databaseId, projectId: ctx.projectId } : {};
  }

  async mapScheduledBackupRefs(schedule: any): Promise<EngineRefs> {
    const ns = schedule.metadata?.namespace;
    const clusterName = schedule.spec?.cluster?.name;
    if (!ns || !clusterName) return {};
    const ctx = await this.resolveCtx(ns, clusterName);
    return ctx ? { databaseId: ctx.databaseId, projectId: ctx.projectId } : {};
  }

  async onScheduledBackupEvent(type: EngineEventType, schedule: any): Promise<void> {
    const ns = schedule.metadata?.namespace;
    const name = schedule.metadata?.name;
    const clusterName = schedule.spec?.cluster?.name;
    if (!ns || !name || !clusterName || name !== cnpgScheduleName(clusterName)) return;
    const ctx = await this.resolveCtx(ns, clusterName);
    if (!ctx) return;
    if (type === 'delete') {
      await this.confirmScheduleRemoval(ctx, ns, clusterName, name);
      return;
    }
    this.scheduleAbsentSince.delete(ctx.databaseId);
    if (schedule.metadata?.deletionTimestamp) return;
    await this.adoptSchedule(ctx, ns, clusterName, schedule);
  }

  private async adoptSchedule(ctx: Ctx, ns: string, clusterName: string, schedule: any) {
    const row = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: { status: true, backupScheduleCron: true, backupScheduleDisabled: true }
    });
    if (!row || row.status === 'deleting') return;
    const cron = scheduleCronUpdate(row, schedule.spec?.schedule);
    if (cron === null) return;
    if (row.backupScheduleDisabled) {
      const live = await this.liveScheduledBackup(ns, clusterName);
      if (live === 'unknown') {
        throw new Error(
          `schedule adoption for ${ns}/${clusterName} deferred: apiserver unreadable`
        );
      }
      if (live === 'absent') return;
    }
    await this.prisma.database.update({
      where: { id: ctx.databaseId },
      data: { backupScheduleCron: cron, backupScheduleDisabled: false }
    });
    this.logger.log(`${ns}/${clusterName}: took backup schedule ${cron} from the cluster`);
    this.scheduleEmit(ctx, { backupSchedule: cron });
  }

  private async confirmScheduleRemoval(
    ctx: Ctx,
    ns: string,
    clusterName: string,
    name: string
  ): Promise<void> {
    const row = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: {
        name: true,
        status: true,
        namespace: true,
        clusterName: true,
        backupScheduleCron: true,
        backupScheduleDisabled: true
      }
    });
    if (
      !row ||
      row.namespace !== ns ||
      row.clusterName !== clusterName ||
      SETTLING_STATUSES.has(row.status) ||
      (row.backupScheduleDisabled && !row.backupScheduleCron)
    ) {
      this.scheduleAbsentSince.delete(ctx.databaseId);
      return;
    }

    const schedule = await this.liveScheduledBackup(ns, clusterName);
    if (schedule === 'present') {
      this.scheduleAbsentSince.delete(ctx.databaseId);
      return;
    }
    if (schedule === 'unknown') {
      throw new ScheduleRemovalPending(
        `schedule removal for ${ns}/${name} deferred: the apiserver could not confirm the delete`
      );
    }
    const cluster = await this.liveCluster(ns, clusterName);
    if (cluster !== 'present') {
      this.scheduleAbsentSince.delete(ctx.databaseId);
      if (cluster === 'unknown') {
        throw new ScheduleRemovalPending(
          `schedule removal for ${ns}/${name} deferred: cluster unreadable`
        );
      }
      return;
    }

    const now = Date.now();
    const first = this.scheduleAbsentSince.get(ctx.databaseId);
    if (first === undefined) {
      this.scheduleAbsentSince.set(ctx.databaseId, now);
      throw new ScheduleRemovalPending(`schedule removal for ${ns}/${name} awaiting confirmation`);
    }
    if (now - first < this.confirmAfterMs) {
      throw new ScheduleRemovalPending(`schedule removal for ${ns}/${name} awaiting confirmation`);
    }
    this.scheduleAbsentSince.delete(ctx.databaseId);

    const previousCron = row.backupScheduleCron;
    await this.prisma.database.update({
      where: { id: ctx.databaseId },
      data: { backupScheduleCron: null, backupScheduleDisabled: true }
    });
    this.logger.warn(
      `${ns}/${name} confirmed deleted in the cluster; scheduled backups for database ${ctx.databaseId} are now off`
    );
    await this.audit.log({
      action: 'database.backup_schedule.deleted',
      organizationId: ctx.orgId,
      projectId: ctx.projectId,
      targetType: 'database',
      targetId: ctx.databaseId,
      targetLabel: row.name,
      metadata: {
        reason: K8S_DELETED_REASON,
        source: 'engine.cnpg',
        namespace: ns,
        scheduledBackup: name,
        previousCron,
        firstAbsentAt: new Date(first).toISOString(),
        confirmedAbsentAt: new Date(now).toISOString()
      }
    });
    this.scheduleEmit(ctx, { backupSchedule: null });
  }

  protected async liveScheduledBackup(ns: string, clusterName: string): Promise<LiveState> {
    return this.liveRead(() => this.cnpg.hasScheduledBackup(ns, clusterName));
  }

  protected async liveCluster(ns: string, clusterName: string): Promise<LiveState> {
    return this.liveRead(() => this.cnpg.hasCnpgCluster(ns, clusterName));
  }

  private async liveRead(read: () => Promise<boolean>): Promise<LiveState> {
    try {
      return (await read()) ? 'present' : 'absent';
    } catch (err: any) {
      this.logger.warn(`could not read from the apiserver: ${err?.message ?? err}`);
      return 'unknown';
    }
  }

  async onPodEvent(type: EngineEventType, pod: k8s.V1Pod): Promise<void> {
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

  private async syncPod(type: EngineEventType, databaseId: string, pod: k8s.V1Pod) {
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

  async sweepVolumes(): Promise<{ sampled: number; guarded: number } | null> {
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
        volumeUsedBytes: true,
        volumeCapacityBytes: true,
        project: { select: { organizationId: true } }
      }
    });
    const clusters = await this.prisma.k8sObject.findMany({
      where: { shard: 'cnpg', kind: 'Cluster', databaseId: { in: databases.map((d) => d.id) } },
      select: { databaseId: true, manifest: true }
    });
    const guardOn = new Map<string, boolean>();
    for (const c of clusters) {
      const annotations = (c.manifest as any)?.metadata?.annotations ?? {};
      guardOn.set(c.databaseId!, annotations[WRITE_GUARD_ANNOTATION] === 'storage');
    }
    let sampled = 0;
    let guarded = 0;
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
        let guardUsage: DiskUsage = volume;
        if (volume.shared) {
          const own = measuredAllowance(db);
          await this.trackStorage(ctx, {
            volumeUsedBytes: own?.usedBytes ?? null,
            volumeCapacityBytes: own?.capacityBytes ?? null,
            nodeDiskUsedBytes: volume.usedBytes,
            nodeDiskCapacityBytes: volume.capacityBytes,
            walPendingSegments: db.walPendingSegments
          });
          guardUsage = fullerOf(volume, own);
        } else {
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
        }
        const decision = writeGuardDecision(
          guardOn.get(db.id) ?? false,
          guardUsage.usedBytes,
          guardUsage.capacityBytes
        );
        if (decision) {
          await this.applyWriteGuard(db, decision, guardUsage.usedBytes, guardUsage.capacityBytes);
          guarded += 1;
        }
      } catch (err) {
        this.logger.warn(
          `volume sweep for ${db.namespace}/${db.clusterName} failed: ${(err as Error)?.message ?? err}`
        );
      }
    }
    if (guarded > 0) {
      this.logger.log(`volume sweep: ${sampled} sampled, ${guarded} write guards changed`);
    }
    return { sampled, guarded };
  }

  private async applyWriteGuard(
    db: { id: string; namespace: string | null; clusterName: string | null },
    decision: 'on' | 'off',
    usedBytes: number,
    capacityBytes: number
  ): Promise<void> {
    const fillPercent = Math.round((usedBytes / capacityBytes) * 100);
    this.logger.warn(
      `[DB/storage] ${db.namespace}/${db.clusterName} is ${fillPercent}% full, write guard ${decision}`
    );
    await this.cnpg.setCnpgWriteGuard(db.namespace!, db.clusterName!, decision === 'on');
    await this.notifications.notifyDbWriteGuard(db.id, decision, fillPercent).catch(() => {});
  }

  private repairArchivingTarget(databaseId: string): void {
    try {
      const databases = this.moduleRef.get(DatabasesService, { strict: false });
      void databases.repairBackupTarget(databaseId).catch((err: any) => {
        this.logger.warn(`archiving repair for ${databaseId} failed: ${err?.message ?? err}`);
      });
    } catch {
      this.logger.warn(`archiving repair for ${databaseId} skipped: databases service unavailable`);
    }
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
        select: {
          dbName: true,
          storageSize: true,
          volumeUsedBytes: true,
          volumeCapacityBytes: true
        }
      });
      if (!db) return;
      this.lastDataDirMeasure ??= new Map();
      const measureDataDir =
        now - (this.lastDataDirMeasure.get(ctx.databaseId) ?? 0) >= DATA_DIR_MEASURE_EVERY_MS;
      const stats = await this.cnpg.sampleDatabaseStats(namespace, pod, db.dbName, {
        measureDataDir
      });
      if (!stats) return;
      this.lastSample.set(ctx.databaseId, Date.now());
      if (stats.shared && measureDataDir) this.lastDataDirMeasure.set(ctx.databaseId, now);
      const allowance = parseMemory(db.storageSize ?? '');
      const previous =
        allowance > 0 && db.volumeUsedBytes != null && Number(db.volumeCapacityBytes) === allowance
          ? { usedBytes: Number(db.volumeUsedBytes), capacityBytes: allowance }
          : null;
      const own: DiskUsage | null = !stats.shared
        ? stats.volumeUsedBytes == null || stats.volumeCapacityBytes == null
          ? null
          : { usedBytes: stats.volumeUsedBytes, capacityBytes: stats.volumeCapacityBytes }
        : !(allowance > 0)
          ? null
          : stats.shared.dataDirBytes == null
            ? previous
            : { usedBytes: stats.shared.dataDirBytes, capacityBytes: allowance };
      await this.prisma.database.update({
        where: { id: ctx.databaseId },
        data: {
          sizeBytes: BigInt(Math.round(stats.sizeBytes)),
          connections: stats.connections,
          statsAt: new Date(),
          volumeUsedBytes: own ? BigInt(Math.round(own.usedBytes)) : null,
          volumeCapacityBytes: own ? BigInt(Math.round(own.capacityBytes)) : null,
          walPendingSegments: stats.walPendingSegments ?? null
        }
      });
      this.scheduleEmit(ctx, { stats: true });
      await this.trackStorage(ctx, {
        volumeUsedBytes: own?.usedBytes ?? null,
        volumeCapacityBytes: own?.capacityBytes ?? null,
        walPendingSegments: stats.walPendingSegments,
        ...(stats.shared
          ? {
              nodeDiskUsedBytes: stats.volumeUsedBytes,
              nodeDiskCapacityBytes: stats.volumeCapacityBytes
            }
          : {})
      });
    } catch (err) {
      this.logger.warn(`sampleStats(${ctx.databaseId}) failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.sampling.delete(ctx.databaseId);
    }
  }

  async onClusterEvent(type: EngineEventType, cluster: any): Promise<void> {
    const ns = cluster.metadata?.namespace;
    const name = cluster.metadata?.name;
    if (!ns || !name) return;
    const ctx = await this.resolveCtx(ns, name, { fresh: true });
    if (!ctx) return;

    if (type === 'delete') {
      const state = await this.liveCluster(ns, name);
      if (state === 'present') return;
      if (state === 'unknown') {
        throw new Error(
          `cluster ${ns}/${name} looks deleted but the apiserver could not confirm it`
        );
      }
      this.archivingState.delete(`${ns}/${name}`);
      await this.writebackStatus(ctx, { deleted: true });
      await this.writebackSnapshot(ctx, { ...clusterSnapshot(cluster), exists: false });
      this.scheduleEmit(ctx, { cluster: 'deleted' });
      return;
    }

    await this.trackArchiving(ctx, ns, name, cluster);
    await this.adoptHibernation(ctx, ns, name, cluster);
    await this.writebackStatus(ctx, { cluster });
    const snapshot = clusterSnapshot(cluster);
    await this.writebackSnapshot(ctx, snapshot);
    await this.syncSpecColumns(ctx, ns, name, cluster);
    await this.adoptSettings(ctx, ns, name, cluster);
    this.scheduleEmit(ctx, { cluster: snapshot.phase, readyInstances: snapshot.readyInstances });
  }

  private async syncSpecColumns(ctx: Ctx, ns: string, name: string, cluster: any) {
    const row = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: {
        status: true,
        importBoosted: true,
        storageSize: true,
        replicas: true,
        pgMajor: true,
        sharedPreloadLibs: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true
      }
    });
    if (!row || row.status === 'deleting') return;
    const update = specColumnUpdate(
      row,
      clusterSpecValues(cluster),
      row.importBoosted
        ? null
        : await this.resolvedResources(ctx.projectId, row).catch((err) => {
            this.logger.warn(
              `resources for ${ns}/${name} not resolved: ${(err as Error)?.message ?? err}`
            );
            return null;
          })
    );
    const fields = Object.keys(update);
    if (fields.length === 0) return;
    await this.prisma.database.update({ where: { id: ctx.databaseId }, data: update });
    this.logger.log(`${ns}/${name}: took ${fields.join(', ')} from the cluster spec`);
  }

  private async resolvedResources(
    projectId: string,
    row: { cpuRequestMilli: number | null; memoryRequestBytes: bigint | null }
  ): Promise<ResolvedResources | null> {
    const quotas = this.moduleRef.get(QuotasService, { strict: false });
    if (!quotas) return null;
    const [current, defaults] = await Promise.all([
      quotas.resolvePodResources(
        projectId,
        {
          cpuRequestMilli: row.cpuRequestMilli,
          memoryRequestBytes: row.memoryRequestBytes != null ? Number(row.memoryRequestBytes) : null
        },
        'postgres'
      ),
      quotas.resolvePodResources(projectId, {}, 'postgres')
    ]);
    return { current, defaults };
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
  private async adoptSettings(ctx: Ctx, ns: string, name: string, cluster: any) {
    const db = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: {
        status: true,
        name: true,
        projectId: true,
        pgParameters: true,
        backupCompression: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!db || SETTINGS_LEAVES_ALONE.has(db.status)) return;
    const stored = (db.pgParameters as Record<string, string> | null) ?? {};
    const plan = planParameterAdoption(cluster, stored);
    const compression = planCompressionAdoption(cluster, db.backupCompression);

    const key = `${ns}/${name}`;
    const refused = plan?.refused.join(',') ?? '';
    if (refused && this.refusedSettings.get(key) !== refused) {
      this.logger.warn(
        `database ${key}: not adopting ${refused} from the cluster: out of range, unsafe for its memory, or removed together with every other setting`
      );
    }
    if (refused) this.refusedSettings.set(key, refused);
    else this.refusedSettings.delete(key);

    const data: Record<string, unknown> = {};
    if (plan && plan.changed.length > 0) data.pgParameters = plan.parameters;
    if (compression !== null && compression !== db.backupCompression) {
      data.backupCompression = compression;
    }
    if (Object.keys(data).length === 0) return;

    await this.prisma.database.update({ where: { id: ctx.databaseId }, data });
    this.logger.log(
      `adopted settings for ${key} from the cluster: ${[
        ...(plan?.changed ?? []),
        ...(data.backupCompression ? [`backupCompression=${String(data.backupCompression)}`] : [])
      ].join(', ')}`
    );
    void this.audit.log({
      action: 'database.settings.updated',
      organizationId: db.project.organizationId,
      projectId: db.projectId,
      targetType: 'database',
      targetId: ctx.databaseId,
      targetLabel: db.name,
      metadata: {
        reason: 'edited in k8s',
        source: 'engine.cnpg',
        changed: plan?.changed.join(',') || null,
        backupCompression:
          data.backupCompression !== undefined
            ? [db.backupCompression, data.backupCompression]
            : null
      }
    });
  }

  private async adoptHibernation(ctx: Ctx, ns: string, name: string, cluster: any) {
    const db = await this.prisma.database.findUnique({
      where: { id: ctx.databaseId },
      select: {
        status: true,
        name: true,
        projectId: true,
        clusterName: true,
        backupScheduleDisabled: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!db || db.clusterName !== name) return;
    const next = hibernationTransition(cluster, db.status);
    if (!next) return;
    const updated = await this.prisma.database.updateMany({
      where: { id: ctx.databaseId, status: db.status, clusterName: name },
      data: { status: next }
    });
    if (updated.count === 0) return;
    const stopping = next === 'stopped';
    if (stopping || !db.backupScheduleDisabled) {
      await this.cnpg
        .setScheduledBackupSuspended(ns, name, stopping)
        .catch((e: any) =>
          this.logger.warn(
            `could not ${stopping ? 'suspend' : 'resume'} the backup schedule for ${ns}/${name}: ${e?.message ?? e}`
          )
        );
    }
    this.logger.log(
      `database ${ns}/${name} was ${stopping ? 'hibernated' : 'woken'} in the cluster; status ${db.status} -> ${next}`
    );
    void this.audit.log({
      action: stopping ? 'database.stopped' : 'database.started',
      organizationId: db.project.organizationId,
      projectId: db.projectId,
      targetType: 'database',
      targetId: ctx.databaseId,
      targetLabel: db.name,
      metadata: { reason: 'hibernation changed in k8s', source: 'engine.cnpg', namespace: ns }
    });
  }

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
      if (next === 'ready') this.installDropGuard(ctx.databaseId);
    }
  }

  private installDropGuard(databaseId: string) {
    try {
      void this.moduleRef
        .get(DatabaseCheckpointsService, { strict: false })
        .ensureGuard(databaseId)
        .catch((e: any) => this.logger.warn(`drop guard on ${databaseId}: ${e?.message ?? e}`));
    } catch (e: any) {
      this.logger.warn(`drop guard on ${databaseId}: ${e?.message ?? e}`);
    }
  }

  private async trackStorage(ctx: Ctx, stats: StoragePressureInput): Promise<void> {
    const prev = this.storageState.get(ctx.databaseId);
    const pressured = storagePressure(prev, stats);
    this.storageState.set(ctx.databaseId, pressured);
    if (prev === pressured || (prev === undefined && !pressured)) return;
    await this.notifications
      .notifyDbStorage(
        ctx.databaseId,
        pressured ? 'pressure' : 'recovered',
        pressured ? storagePressureDetail(stats) : undefined,
        pressured && nodeDiskPressure(stats)
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
    if (!ok) this.repairArchivingTarget(ctx.databaseId);
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

  private buildPodPayload(type: EngineEventType, pod: k8s.V1Pod) {
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

  private async resolveCtx(
    ns: string,
    clusterName: string,
    opts: { fresh?: boolean } = {}
  ): Promise<Ctx | null> {
    const key = `${ns}/${clusterName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now() && !opts.fresh) return cached.ctx;

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
