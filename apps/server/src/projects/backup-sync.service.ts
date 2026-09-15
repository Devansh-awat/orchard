import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { DEFAULT_BACKUP_CRON, toQuartzCron } from './projects.utils';

const MISSING_CR_GRACE_MS = 10 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const NOTIFY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const INGEST_EVERY_N_TICKS = 5;
const MAX_COMPLETED_BACKUPS = 10;
const SCHEDULE_SWEEP_EVERY_N_TICKS = 30;
const MAX_SCHEDULES_PER_SWEEP = 5;

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
                  { backupScheduleCron: { not: null } }
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
   *     (the k8s call failed at some point, which used to happen a lot)
   *   - the cluster archives, has no schedule, and has never produced a single
   *     backup, which is the state that fills the bucket
   *
   * A database that has taken backups and then had its schedule cleared is
   * someone choosing manual backups, so it is left alone.
   */
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
        _count: { select: { backups: true } }
      }
    });

    let repaired = 0;
    for (const db of databases) {
      if (repaired >= MAX_SCHEDULES_PER_SWEEP) break;
      if (!db.backupScheduleCron && db._count.backups > 0) continue;
      const namespace = db.namespace!;
      const clusterName = db.clusterName!;
      try {
        // Not archiving means backups are off, or the org has no storage.
        // Nothing accumulates, so there is nothing to anchor.
        if (!(await this.k8sCnpg.isCnpgBackupConfigured(namespace, clusterName))) continue;
        if (await this.k8sCnpg.hasScheduledBackup(namespace, clusterName)) continue;

        const cron = db.backupScheduleCron || DEFAULT_BACKUP_CRON;
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
        const phase: string | undefined = live?.status?.phase;
        const ageMs = Date.now() - row.createdAt.getTime();

        let newStatus: 'completed' | 'failed' | 'running' | null = null;
        let errorMessage: string | null = null;
        if (!live) {
          if (ageMs > MISSING_CR_GRACE_MS) {
            newStatus = 'failed';
            errorMessage = 'Backup resource not found in cluster';
          }
        } else if (phase === 'completed') {
          newStatus = 'completed';
        } else if (phase === 'failed') {
          newStatus = 'failed';
          errorMessage = String(live.status?.error || '').substring(0, 2000) || null;
        } else if ((phase === 'running' || phase === 'started') && row.status === 'pending') {
          newStatus = 'running';
        } else if (ageMs > BACKUP_TIMEOUT_MS) {
          newStatus = 'failed';
          errorMessage = 'Backup timed out';
        }

        if (!newStatus || newStatus === row.status) continue;
        const terminal = newStatus === 'completed' || newStatus === 'failed';
        const claimed = await this.prisma.databaseBackup.updateMany({
          where: { id: row.id, status: { in: ['pending', 'running'] } },
          data: {
            status: newStatus,
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
      anyNewlyCompleted = (await this.ingestUntrackedBackups(database)) || anyNewlyCompleted;
    }

    return anyNewlyCompleted;
  }

  private async ingestUntrackedBackups(database: DatabaseRef): Promise<boolean> {
    let anyNewlyCompleted = false;
    let liveBackups: any[] = [];
    try {
      liveBackups = await this.k8sCnpg.listCnpgBackups(database.namespace!, database.clusterName!);
    } catch {
      return false;
    }
    if (liveBackups.length === 0) return false;

    const existing = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id },
      select: { backupName: true }
    });
    const known = new Set(existing.map((r) => r.backupName));

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
            createdAt
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
      try {
        await this.prisma.databaseBackup.delete({ where: { id: b.id } });
      } catch (e: any) {
        this.logger.warn(`failed to delete old backup record ${b.id}: ${e?.message ?? e}`);
      }
    }
  }
}
