import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import type { DatabaseCheckpoint, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import {
  createRestorePointSql,
  DDL_GUARD_VERSION,
  ddlGuardInstallSql,
  ddlGuardPresentSql,
  ddlGuardRemoveSql,
  ddlGuardTableMissing,
  guardCheckpointsSql,
  LAST_ARCHIVED_WAL_SQL,
  parseDdlGuardPresent,
  parseGuardCheckpoints,
  parseRestorePoint,
  restorePointName,
  walArchived,
  type CheckpointKind
} from '../kubernetes/cnpg-checkpoint';
import { RETENTION_POLICY } from '../kubernetes/cnpg-recovery';
import { hasBackupRoute } from '../instance-config/object-storage';

const RETENTION_MS = Number.parseInt(RETENTION_POLICY, 10) * 24 * 60 * 60 * 1000;
const DURABLE_GIVE_UP_MS = 30 * 60 * 1000;
const PARALLEL = 8;
const BEFORE_TIMEOUT_MS = 8000;

export interface CheckpointRequest {
  label?: string;
  kind: CheckpointKind;
  createdBy?: string | null;
  deploymentId?: string | null;
  releaseId?: string | null;
  detail?: string | null;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.allSettled(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const BACKUP_STORAGE_SELECT = {
  backupR2Endpoint: true,
  backupR2Bucket: true,
  backupR2AccessKey: true,
  backupR2SecretKey: true
} as const;

const GUARD_RETRY_MS = 5 * 60 * 1000;

const GUARD_TARGET_SELECT = {
  id: true,
  name: true,
  namespace: true,
  clusterName: true,
  dbName: true,
  ddlCheckpoints: true,
  ddlGuardVersion: true,
  backupServerName: true,
  project: { select: { organization: { select: BACKUP_STORAGE_SELECT } } }
} satisfies Prisma.DatabaseSelect;

type GuardTarget = Prisma.DatabaseGetPayload<{ select: typeof GUARD_TARGET_SELECT }>;

@Injectable()
export class DatabaseCheckpointsService {
  private readonly logger = new Logger(DatabaseCheckpointsService.name);

  private ticking = false;

  private guardTick = 0;

  private guardLost = false;

  private readonly guardSeq = new Map<string, number>();

  private readonly guardRetryAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly leader: LeaderElectionService,
    private readonly settings: InstanceSettingsService
  ) {}

  async databaseIdsFor(scope: {
    databaseIds?: string[];
    projectId?: string;
    environmentId?: string;
  }): Promise<string[]> {
    if (scope.databaseIds?.length) return [...new Set(scope.databaseIds)];
    if (!scope.projectId && !scope.environmentId) {
      throw new BadRequestException('Pass databaseIds, projectId or environmentId');
    }
    const rows = await this.prisma.database.findMany({
      where: {
        mode: 'cnpg',
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.environmentId ? { environmentId: scope.environmentId } : {})
      },
      select: { id: true }
    });
    return rows.map((r) => r.id);
  }

  async create(databaseIds: string[], req: CheckpointRequest) {
    const groupId = databaseIds.length > 1 ? randomUUID() : null;
    const label = (req.label || defaultLabel(req.kind)).slice(0, 255);
    const results = await inBatches(databaseIds, PARALLEL, (id) =>
      this.createOne(id, { ...req, label }, groupId)
    );
    return {
      groupId,
      checkpoints: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : {
              databaseId: databaseIds[i],
              status: 'failed',
              error: String((r.reason as any)?.message ?? r.reason)
            }
      )
    };
  }

  async before(databaseId: string, reason: string, createdBy?: string | null) {
    try {
      if (!(await this.backupRouteFor(databaseId))) return null;
      return await Promise.race([
        this.createOne(databaseId, { kind: 'pre_op', label: `Before ${reason}`, createdBy }, null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), BEFORE_TIMEOUT_MS).unref?.())
      ]);
    } catch (e: any) {
      this.logger.warn(`checkpoint before ${reason} on ${databaseId} skipped: ${e?.message ?? e}`);
      return null;
    }
  }

  private async backupRouteFor(databaseId: string): Promise<boolean> {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: { project: { select: { organization: { select: BACKUP_STORAGE_SELECT } } } }
    });
    return hasBackupRoute(db?.project?.organization);
  }

  private async createOne(
    databaseId: string,
    req: CheckpointRequest & { label: string },
    groupId: string | null
  ): Promise<DatabaseCheckpoint> {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db) throw new NotFoundException('Database not found');
    if (db.mode !== 'cnpg' || !db.namespace || !db.clusterName) {
      throw new BadRequestException(`${db.name} isn't a dedicated database`);
    }
    if (!(await this.backupRouteFor(databaseId))) {
      throw new BadRequestException(
        'Checkpoints need backup storage. Add a backup bucket for this organization or the instance first.'
      );
    }
    if (db.status === 'stopped') throw new BadRequestException(`${db.name} is stopped`);
    const id = randomUUID();
    const name = restorePointName(req.kind, id);
    const row = await this.prisma.databaseCheckpoint.create({
      data: {
        id,
        databaseId,
        groupId,
        label: req.label,
        kind: req.kind,
        restorePointName: name,
        serverName: db.backupServerName || db.clusterName,
        deploymentId: req.deploymentId ?? null,
        releaseId: req.releaseId ?? null,
        detail: req.detail ?? null,
        createdBy: req.createdBy ?? null,
        expiresAt: new Date(Date.now() + RETENTION_MS)
      }
    });
    const out = await this.k8sCnpg.runPsqlInCnpg(
      db.namespace,
      db.clusterName,
      'postgres',
      createRestorePointSql(name),
      { tuplesOnly: true }
    );
    const point = out.success ? parseRestorePoint(out.stdout) : null;
    if (!point) {
      return this.prisma.databaseCheckpoint.update({
        where: { id },
        data: {
          status: 'failed',
          error: (out.stderr || out.stdout || 'No restore point').slice(0, 2000)
        }
      });
    }
    const hasBase = await this.prisma.databaseBackup.findFirst({
      where: { databaseId, status: 'completed' },
      select: { id: true }
    });
    if (!hasBase) await this.startFirstBackup(db.namespace, db.clusterName, databaseId);
    return this.prisma.databaseCheckpoint.update({
      where: { id: row.id },
      data: { lsn: point.lsn, walFile: point.walFile }
    });
  }

  private async startFirstBackup(namespace: string, clusterName: string, databaseId: string) {
    const inflight = await this.prisma.databaseBackup.findFirst({
      where: { databaseId, status: { in: ['pending', 'running'] } },
      select: { id: true }
    });
    if (inflight) return;
    const backupName = `${clusterName}-first-${Date.now().toString(36)}`.slice(0, 63);
    await this.k8sCnpg.createCnpgBackup(namespace, clusterName, backupName);
    await this.prisma.databaseBackup.create({
      data: { databaseId, label: 'First backup for checkpoints', backupName, status: 'pending' }
    });
  }

  list(databaseId: string, opts: { includeHidden?: boolean; take?: number } = {}) {
    return this.prisma.databaseCheckpoint.findMany({
      where: { databaseId, ...(opts.includeHidden ? {} : { hiddenAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: opts.take ?? 100
    });
  }

  listGroup(groupId: string) {
    return this.prisma.databaseCheckpoint.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' }
    });
  }

  get(id: string) {
    return this.prisma.databaseCheckpoint.findUnique({ where: { id } });
  }

  async hide(id: string) {
    const cp = await this.get(id);
    if (!cp) throw new NotFoundException('Checkpoint not found');
    return this.prisma.databaseCheckpoint.update({ where: { id }, data: { hiddenAt: new Date() } });
  }

  @Interval(30_000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      await this.markDurable();
      await this.prisma.databaseCheckpoint.updateMany({
        where: { status: 'durable', expiresAt: { lt: new Date() } },
        data: { status: 'expired' }
      });
      this.guardTick += 1;
      await this.installMissingGuards();
      if (this.guardTick % 4 === 1) await this.ingestGuardCheckpoints();
      if (this.guardTick % 20 === 1 || this.guardLost) {
        this.guardLost = false;
        await this.reconcileGuards();
      }
    } catch (e: any) {
      this.logger.warn(`checkpoint tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async markDurable() {
    const pending = await this.prisma.databaseCheckpoint.findMany({
      where: { status: 'pending', walFile: { not: null } },
      select: { id: true, databaseId: true, walFile: true, createdAt: true },
      take: 500
    });
    const byDb = new Map<string, typeof pending>();
    for (const cp of pending) byDb.set(cp.databaseId, [...(byDb.get(cp.databaseId) ?? []), cp]);
    await inBatches([...byDb.entries()], PARALLEL, async ([databaseId, cps]) => {
      const db = await this.prisma.database.findUnique({
        where: { id: databaseId },
        select: { namespace: true, clusterName: true }
      });
      if (!db?.namespace || !db.clusterName) return;
      const out = await this.k8sCnpg.runPsqlInCnpg(
        db.namespace,
        db.clusterName,
        'postgres',
        LAST_ARCHIVED_WAL_SQL,
        {
          tuplesOnly: true
        }
      );
      if (!out.success) return;
      const last = out.stdout.trim();
      for (const cp of cps) {
        if (walArchived(last, cp.walFile!)) {
          await this.prisma.databaseCheckpoint.update({
            where: { id: cp.id },
            data: { status: 'durable', durableAt: new Date() }
          });
        } else if (Date.now() - cp.createdAt.getTime() > DURABLE_GIVE_UP_MS) {
          await this.prisma.databaseCheckpoint.update({
            where: { id: cp.id },
            data: { status: 'failed', error: 'Its WAL never reached the backup store' }
          });
        }
      }
    });
  }

  private async guardTargets(installed: boolean, only: Prisma.DatabaseWhereInput = {}) {
    return this.prisma.database.findMany({
      where: {
        mode: 'cnpg',
        status: 'ready',
        namespace: { not: null },
        clusterName: { not: null },
        ...(installed ? { ddlGuardVersion: { not: null } } : {}),
        ...only
      },
      select: GUARD_TARGET_SELECT
    });
  }

  private async guardsWanted(only: Prisma.DatabaseWhereInput) {
    if (!(await this.settings.isDatabaseToggleOn('ddlCheckpoints'))) return [];
    const dbs = await this.guardTargets(false, {
      ddlCheckpoints: true,
      ddlGuardVersion: null,
      ...only
    });
    return dbs.filter((d) => hasBackupRoute(d.project?.organization));
  }

  private async installMissingGuards() {
    const now = Date.now();
    const due = (await this.guardsWanted({})).filter(
      (d) => (this.guardRetryAt.get(d.id) ?? 0) <= now
    );
    await inBatches(due.slice(0, 40), 4, (d) => this.applyGuard(d, true));
  }

  async ensureGuard(databaseId: string) {
    const [db] = await this.guardsWanted({ id: databaseId });
    if (db) await this.applyGuard(db, true);
  }

  private async applyGuard(d: GuardTarget, install: boolean) {
    const out = await this.k8sCnpg.runPsqlInCnpg(
      d.namespace!,
      d.clusterName!,
      d.dbName,
      install ? ddlGuardInstallSql() : ddlGuardRemoveSql()
    );
    if (!out.success) {
      this.guardRetryAt.set(d.id, Date.now() + GUARD_RETRY_MS);
      this.logger.warn(
        `drop guard ${install ? 'install' : 'removal'} on ${d.name} failed: ${(out.stderr || '').slice(0, 300)}`
      );
      return;
    }
    this.guardRetryAt.delete(d.id);
    this.guardSeq.delete(guardSeqKey(d));
    await this.prisma.database.update({
      where: { id: d.id },
      data: { ddlGuardVersion: install ? DDL_GUARD_VERSION : null }
    });
  }

  private async reconcileGuards() {
    const enabled = await this.settings.isDatabaseToggleOn('ddlCheckpoints');
    const dbs = await this.guardTargets(false);
    const wanted = (d: (typeof dbs)[number]) =>
      enabled && d.ddlCheckpoints && hasBackupRoute(d.project?.organization);
    const work = dbs.filter((d) =>
      wanted(d) ? d.ddlGuardVersion !== DDL_GUARD_VERSION : d.ddlGuardVersion !== null
    );
    const recorded = dbs.filter((d) => wanted(d) && d.ddlGuardVersion === DDL_GUARD_VERSION);
    const probes = await inBatches(recorded, PARALLEL, async (d) => {
      const out = await this.k8sCnpg.runPsqlInCnpg(
        d.namespace!,
        d.clusterName!,
        d.dbName,
        ddlGuardPresentSql(),
        { tuplesOnly: true }
      );
      return out.success ? parseDdlGuardPresent(out.stdout) : null;
    });
    const lost = recorded.filter((_, i) => {
      const probe = probes[i];
      return probe.status === 'fulfilled' && probe.value === false;
    });
    await inBatches([...work, ...lost].slice(0, 40), 4, (d) => this.applyGuard(d, wanted(d)));
  }

  private async ingestGuardCheckpoints() {
    const dbs = (await this.guardTargets(true)).filter(
      (d) => d.ddlCheckpoints && hasBackupRoute(d.project?.organization)
    );
    await inBatches(dbs, PARALLEL, async (d) => {
      const after = this.guardSeq.get(guardSeqKey(d)) ?? 0;
      const out = await this.k8sCnpg.runPsqlInCnpg(
        d.namespace!,
        d.clusterName!,
        d.dbName,
        guardCheckpointsSql(after),
        { tuplesOnly: true }
      );
      if (!out.success) {
        if (ddlGuardTableMissing(out.stderr)) {
          this.logger.warn(`drop guard missing on ${d.name}, reinstalling`);
          await this.prisma.database.update({
            where: { id: d.id },
            data: { ddlGuardVersion: null }
          });
          this.guardLost = true;
        }
        return;
      }
      const rows = parseGuardCheckpoints(out.stdout);
      if (rows.length === 0) return;
      await this.prisma.databaseCheckpoint.createMany({
        data: rows.map((r) => ({
          databaseId: d.id,
          label: `Before ${r.command.toLowerCase()}`,
          kind: 'ddl',
          restorePointName: r.restorePointName,
          lsn: r.lsn,
          walFile: r.walFile,
          serverName: d.backupServerName || d.clusterName,
          detail: `${r.objects} (by ${r.role})`.slice(0, 2000),
          createdAt: new Date(r.createdAt),
          expiresAt: new Date(Date.parse(r.createdAt) + RETENTION_MS)
        })),
        skipDuplicates: true
      });
      this.guardSeq.set(guardSeqKey(d), Math.max(...rows.map((r) => r.seq)));
    }).catch((e) => this.logger.warn(`drop guard ingest failed: ${k8sErrorMessage(e)}`));
  }
}

function guardSeqKey(d: { id: string; clusterName: string | null }): string {
  return `${d.id}/${d.clusterName}`;
}

function defaultLabel(kind: CheckpointKind): string {
  switch (kind) {
    case 'pre_deploy':
      return 'Before deploy';
    case 'pre_op':
      return 'Before a change';
    case 'ddl':
      return 'Before a drop';
    default:
      return 'Checkpoint';
  }
}
