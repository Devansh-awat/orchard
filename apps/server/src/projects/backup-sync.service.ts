import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { cronFromSchedule } from '../kubernetes/cnpg-spec-sync';
import {
  defaultBackupCronFor,
  isBackupSchedulePinned,
  LEGACY_DEFAULT_BACKUP_CRON,
  toQuartzCron
} from './projects.utils';
import {
  backupTransition,
  confirmedOrphans,
  FAILED_RECHECK_MS,
  orphanCandidates,
  orphanKey,
  recoveredBackups,
  SUPERSEDED_MESSAGE,
  supersededBackups
} from './backup-transition';
import { backupFleetGauges } from './backup-telemetry';
import { gauge } from '../analytics/datadog';
import { backupFieldsFromStatus } from '../kubernetes/cnpg-recovery';

const NOTIFY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const INGEST_EVERY_N_TICKS = 5;
const MAX_COMPLETED_BACKUPS = 10;
const BACKUP_ROW_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const SCHEDULE_SWEEP_EVERY_N_TICKS = 30;
const MAX_SCHEDULES_PER_SWEEP = 5;
const MAX_RESPREADS_PER_SWEEP = 20;

interface DatabaseRef {
  id: string;
  namespace: string | null;
  clusterName: string | null;
  mode: string | null;
}

@Injectable()
export class BackupSyncService {
  private readonly logger = new Logger(BackupSyncService.name);

  private tickCount = 0;

  private ticking = false;

  private readonly orphanFirstMissingAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly leader: LeaderElectionService,
    private readonly notifications: NotificationsService
  ) {}

  @Interval(60_000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    this.tickCount += 1;
    const ingest = this.tickCount % INGEST_EVERY_N_TICKS === 1;
    try {
      const databases = await this.prisma.database.findMany({
        where: {
          mode: 'cnpg',
          namespace: { not: null },
          ...(ingest
            ? {
                OR: [
                  { backups: { some: { status: { in: ['pending', 'running'] } } } },
                  { backupScheduleCron: { not: null } },
                  {
                    backups: {
                      some: {
                        status: 'failed',
                        createdAt: { gte: new Date(Date.now() - FAILED_RECHECK_MS) }
                      }
                    }
                  }
                ]
              }
            : { backups: { some: { status: { in: ['pending', 'running'] } } } })
        },
        select: { id: true, namespace: true, clusterName: true, mode: true },
        take: 200
      });
      for (const db of databases) {
        const anyNewlyCompleted = await this.reconcileDatabase(db, { ingest }).catch((e) => {
          this.logger.warn(`reconcile failed for database ${db.id}: ${e?.message ?? e}`);
          return false;
        });
        if (anyNewlyCompleted) {
          await this.pruneOldBackups(db).catch(() => {});
        }
      }
      if (this.tickCount % SCHEDULE_SWEEP_EVERY_N_TICKS === 1) {
        await this.ensureBackupSchedules().catch((e) => {
          this.logger.warn(`schedule sweep failed: ${e?.message ?? e}`);
        });
        await this.respreadLegacySchedules().catch((e) => {
          this.logger.warn(`schedule respread failed: ${e?.message ?? e}`);
        });
      }
      if (ingest) {
        await this.fleetPass().catch((e) => {
          this.logger.warn(`backup fleet pass failed: ${e?.message ?? e}`);
        });
      }
    } catch (e: any) {
      this.logger.warn(`backup sync tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Keeps archiving anchored to a base backup. Barman can only expire WAL that
   * sits behind a backup, so a cluster shipping WAL with no backup at all is
   * one that grows forever and cannot be restored from either. Two repairs:
   *
   *   - our row names a schedule but the ScheduledBackup is not in the cluster
   *     (the k8s call failed at some point)
   *   - the cluster archives, has no schedule, and has never produced a single
   *     backup, which is the state that fills the bucket
   *
   * A database that has taken backups and then had its schedule cleared is
   * someone choosing manual backups, so it is left alone.
   */
  private async fleetPass(): Promise<void> {
    const [clusters, backups, schedules] = await Promise.all([
      this.k8sCnpg.listAllCnpgClusters(),
      this.k8sCnpg.listAllCnpgBackups(),
      this.k8sCnpg.listAllScheduledBackups()
    ]);
    for (const g of backupFleetGauges(clusters, backups)) gauge(g.metric, g.value, g.tags);
    await this.sweepOrphans(clusters, backups, schedules);
  }

  private async sweepOrphans(clusters: any[], backups: any[], schedules: any[]): Promise<void> {
    const candidates = orphanCandidates(clusters, backups, schedules);
    const existence = new Map<string, boolean | null>();
    const missing = new Set<string>();
    for (const c of candidates) {
      const ref = `${c.namespace}/${c.cluster}`;
      if (!existence.has(ref)) {
        const exists = await this.k8sCnpg.cnpgClusterExists(c.namespace, c.cluster).catch((e) => {
          this.logger.warn(`orphan check for ${ref} failed: ${k8sErrorMessage(e)}`);
          return null;
        });
        existence.set(ref, exists);
      }
      if (existence.get(ref) === false) missing.add(orphanKey(c));
    }
    for (const c of confirmedOrphans(candidates, missing, this.orphanFirstMissingAt)) {
      try {
        if (c.kind === 'schedule') {
          await this.k8sCnpg.deleteScheduledBackupNamed(c.namespace, c.name, {
            keepBackups: true
          });
        } else {
          await this.k8sCnpg.deleteCnpgBackup(c.namespace, c.name);
        }
        this.orphanFirstMissingAt.delete(orphanKey(c));
        this.logger.log(
          `removed ${c.kind} ${c.namespace}/${c.name}: its cluster ${c.cluster} no longer exists`
        );
      } catch (e: any) {
        this.logger.warn(
          `removing orphan ${c.kind} ${c.namespace}/${c.name} failed: ${k8sErrorMessage(e)}`
        );
      }
    }
  }

  private async ensureBackupSchedules(): Promise<void> {
    const databases = await this.prisma.database.findMany({
      where: {
        mode: 'cnpg',
        namespace: { not: null },
        clusterName: { not: null },
        status: { notIn: ['deleting', 'restoring', 'error'] }
      },
      select: {
        id: true,
        namespace: true,
        clusterName: true,
        backupScheduleCron: true,
        backupScheduleDisabled: true,
        _count: { select: { backups: true } }
      }
    });

    let repaired = 0;
    for (const db of databases) {
      if (repaired >= MAX_SCHEDULES_PER_SWEEP) break;
      if (db.backupScheduleDisabled) continue;
      if (!db.backupScheduleCron && db._count.backups > 0) continue;
      const namespace = db.namespace!;
      const clusterName = db.clusterName!;
      try {
        // Not archiving means backups are off, or the org has no storage.
        // Nothing accumulates, so there is nothing to anchor.
        if (!(await this.k8sCnpg.isCnpgBackupConfigured(namespace, clusterName))) continue;
        if (await this.k8sCnpg.hasScheduledBackup(namespace, clusterName)) continue;

        const cron = db.backupScheduleCron || defaultBackupCronFor(namespace, clusterName);
        await this.k8sCnpg.upsertScheduledBackup(namespace, clusterName, toQuartzCron(cron), {
          immediate: true
        });
        if (!db.backupScheduleCron) {
          await this.prisma.database.update({
            where: { id: db.id },
            data: { backupScheduleCron: cron }
          });
        }
        repaired += 1;
        this.logger.log(
          `[DB/backup] restored backup schedule ${cron} for ${namespace}/${clusterName}`
        );
      } catch (e: any) {
        this.logger.warn(
          `schedule sweep failed for ${namespace}/${clusterName}: ${k8sErrorMessage(e)}`
        );
      }
    }
  }

  async respreadLegacySchedules(): Promise<number> {
    if (isBackupSchedulePinned()) return 0;
    const databases = await this.prisma.database.findMany({
      where: {
        mode: 'cnpg',
        namespace: { not: null },
        clusterName: { not: null },
        backupScheduleCron: LEGACY_DEFAULT_BACKUP_CRON,
        backupScheduleDisabled: false,
        status: { notIn: ['deleting', 'restoring', 'error'] }
      },
      select: { id: true, namespace: true, clusterName: true },
      take: MAX_RESPREADS_PER_SWEEP
    });

    let moved = 0;
    for (const db of databases) {
      const namespace = db.namespace!;
      const clusterName = db.clusterName!;
      try {
        const live = await this.k8sCnpg.getScheduledBackupSchedule(namespace, clusterName);
        if (live !== null && live !== toQuartzCron(LEGACY_DEFAULT_BACKUP_CRON)) {
          await this.prisma.database.update({
            where: { id: db.id },
            data: { backupScheduleCron: cronFromSchedule(live) }
          });
          continue;
        }
        const cron = defaultBackupCronFor(namespace, clusterName);
        if (live !== null) {
          await this.k8sCnpg.upsertScheduledBackup(namespace, clusterName, toQuartzCron(cron));
        }
        await this.prisma.database.update({
          where: { id: db.id },
          data: { backupScheduleCron: cron }
        });
        moved += 1;
        this.logger.log(
          `[DB/backup] spread backup schedule to ${cron} for ${namespace}/${clusterName}`
        );
      } catch (e: any) {
        this.logger.warn(
          `schedule respread failed for ${namespace}/${clusterName}: ${k8sErrorMessage(e)}`
        );
      }
    }
    return moved;
  }

  async reconcileDatabase(
    database: DatabaseRef,
    opts: { ingest?: boolean } = {}
  ): Promise<boolean> {
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) return false;
    let anyNewlyCompleted = false;

    const rows = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id, status: { in: ['pending', 'running'] } }
    });

    for (const row of rows) {
      try {
        const live = await this.k8sCnpg.getCnpgBackup(database.namespace, row.backupName);
        const transition = backupTransition(row, live);
        if (!transition || transition.status === row.status) continue;
        const newStatus = transition.status;
        const { errorMessage } = transition;
        const terminal = newStatus === 'completed' || newStatus === 'failed';
        const claimed = await this.prisma.databaseBackup.updateMany({
          where: { id: row.id, status: { in: ['pending', 'running'] } },
          data: {
            status: newStatus,
            ...backupFieldsFromStatus(live),
            ...(terminal
              ? {
                  completedAt: new Date(live?.status?.stoppedAt || Date.now()),
                  errorMessage: newStatus === 'failed' ? errorMessage : null
                }
              : {})
          }
        });
        if ((newStatus === 'completed' || newStatus === 'failed') && claimed.count > 0) {
          if (newStatus === 'completed') anyNewlyCompleted = true;
          this.maybeNotify(row.id, newStatus, row.createdAt);
        }
      } catch (e: any) {
        this.logger.warn(`backup reconcile failed for ${row.backupName}: ${e?.message ?? e}`);
      }
    }

    if (opts.ingest) {
      let liveBackups: any[] = [];
      try {
        liveBackups = await this.k8sCnpg.listCnpgBackups(
          database.namespace!,
          database.clusterName!
        );
      } catch {
        return anyNewlyCompleted;
      }
      await this.sweepSupersededBackups(database, liveBackups).catch((e) => {
        this.logger.warn(`superseded sweep failed for ${database.clusterName}: ${e?.message ?? e}`);
      });
      anyNewlyCompleted =
        (await this.ingestUntrackedBackups(database, liveBackups)) || anyNewlyCompleted;
    }

    return anyNewlyCompleted;
  }

  private async sweepSupersededBackups(database: DatabaseRef, liveBackups: any[]): Promise<void> {
    const names = supersededBackups(liveBackups);
    if (names.length === 0) return;
    for (const name of names) {
      await this.k8sCnpg.deleteCnpgBackup(database.namespace!, name);
    }
    await this.prisma.databaseBackup.updateMany({
      where: {
        databaseId: database.id,
        backupName: { in: names },
        status: { in: ['pending', 'running'] }
      },
      data: { status: 'failed', errorMessage: SUPERSEDED_MESSAGE, completedAt: new Date() }
    });
    this.logger.log(
      `[DB/backup] swept ${names.length} superseded scheduled backup(s) from ${database.namespace}/${database.clusterName}`
    );
  }

  private async ingestUntrackedBackups(
    database: DatabaseRef,
    liveBackups: any[]
  ): Promise<boolean> {
    let anyNewlyCompleted = false;
    if (liveBackups.length === 0) return false;

    const existing = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id },
      select: { id: true, backupName: true, barmanId: true, status: true, createdAt: true }
    });
    for (const { row, live } of recoveredBackups(existing, liveBackups)) {
      const claimed = await this.prisma.databaseBackup.updateMany({
        where: { id: row.id, status: 'failed' },
        data: {
          status: 'completed',
          errorMessage: null,
          completedAt: new Date(live.status?.stoppedAt || Date.now()),
          ...backupFieldsFromStatus(live)
        }
      });
      if (claimed.count > 0) {
        anyNewlyCompleted = true;
        this.maybeNotify(row.id, 'completed', row.createdAt);
      }
    }
    const known = new Set(existing.map((r) => r.backupName));
    const unrecorded = new Map(
      existing
        .filter((r) => r.status === 'completed' && !r.barmanId)
        .map((r) => [r.backupName, r.id])
    );
    for (const lb of liveBackups) {
      const id = unrecorded.get(lb.metadata?.name);
      if (!id || lb.status?.phase !== 'completed' || !lb.status?.backupId) continue;
      await this.prisma.databaseBackup
        .update({ where: { id }, data: backupFieldsFromStatus(lb) })
        .catch(() => {});
    }

    for (const lb of liveBackups) {
      const name: string | undefined = lb.metadata?.name;
      if (!name || known.has(name)) continue;
      const phase: string | undefined = lb.status?.phase;
      let status = 'running';
      if (phase === 'completed') status = 'completed';
      else if (phase === 'failed') status = 'failed';
      const terminal = status === 'completed' || status === 'failed';
      const createdAt = new Date(lb.metadata?.creationTimestamp || Date.now());
      try {
        const created = await this.prisma.databaseBackup.create({
          data: {
            databaseId: database.id,
            label: name,
            backupName: name,
            type: lb.metadata?.labels?.['cnpg.io/scheduled-backup'] ? 'scheduled' : 'full',
            status,
            errorMessage:
              status === 'failed'
                ? String(lb.status?.error || '').substring(0, 2000) || null
                : null,
            completedAt: terminal ? new Date(lb.status?.stoppedAt || Date.now()) : null,
            createdAt,
            ...backupFieldsFromStatus(lb)
          }
        });
        if (status === 'completed') anyNewlyCompleted = true;
        if (terminal) this.maybeNotify(created.id, status as 'completed' | 'failed', createdAt);
      } catch {}
    }
    return anyNewlyCompleted;
  }

  private maybeNotify(backupId: string, status: 'completed' | 'failed', createdAt: Date) {
    if (Date.now() - createdAt.getTime() > NOTIFY_MAX_AGE_MS) return;
    this.notifications
      .notifyBackup(backupId, status)
      .catch((e) =>
        this.logger.warn(`backup notification failed for ${backupId}: ${e?.message ?? e}`)
      );
  }

  async pruneOldBackups(database: {
    id: string;
    namespace: string | null;
    clusterName: string | null;
  }) {
    if (!database.namespace || !database.clusterName) return;
    const completed = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id, status: 'completed' },
      orderBy: { createdAt: 'desc' }
    });
    if (completed.length <= MAX_COMPLETED_BACKUPS) return;
    const toDelete = completed.slice(MAX_COMPLETED_BACKUPS);
    for (const b of toDelete) {
      try {
        await this.k8sCnpg.deleteCnpgBackup(database.namespace, b.backupName);
      } catch (e: any) {
        this.logger.warn(`failed to delete old backup CR ${b.backupName}: ${e?.message ?? e}`);
      }
      if (b.completedAt && Date.now() - b.completedAt.getTime() < BACKUP_ROW_RETENTION_MS) continue;
      try {
        await this.prisma.databaseBackup.delete({ where: { id: b.id } });
      } catch (e: any) {
        this.logger.warn(`failed to delete old backup record ${b.id}: ${e?.message ?? e}`);
      }
    }
  }
}
