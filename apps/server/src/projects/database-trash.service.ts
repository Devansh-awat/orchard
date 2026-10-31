import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import type { Database, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { platformBackupTarget } from '../instance-config/object-storage';
import { DatabaseOperationsService, type OperationSource } from './database-operations.service';
import type { DatabasesService } from './databases.service';

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SECRET_FIELDS = ['dbPassword', 'r2ProxySecret', 'r2RestoreSecret'] as const;

@Injectable()
export class DatabaseTrashService {
  private readonly logger = new Logger(DatabaseTrashService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly leader: LeaderElectionService,
    private readonly operations: DatabaseOperationsService,
    private readonly moduleRef: ModuleRef
  ) {}

  private async databases(): Promise<DatabasesService> {
    const { DatabasesService: Svc } = await import('./databases.service.js');
    return this.moduleRef.get(Svc, { strict: false });
  }

  async keep(
    database: Database & {
      project: { organizationId: string; organization?: { backupR2Bucket: string | null } | null };
    },
    opts: { reason: 'user' | 'environment' | 'project'; deletedBy?: string | null }
  ) {
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) return null;
    let recoverableUntil: Date | null = null;
    const out = await Promise.race([
      this.k8sCnpg
        .runPsqlInCnpg(
          database.namespace,
          database.clusterName,
          'postgres',
          'SELECT pg_switch_wal();',
          {
            tuplesOnly: true
          }
        )
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000).unref?.())
    ]);
    if (out?.success) recoverableUntil = new Date();
    const hasBackup = await this.prisma.databaseBackup.findFirst({
      where: { databaseId: database.id, status: 'completed' },
      select: { id: true }
    });
    const bucket =
      database.project.organization?.backupR2Bucket ?? platformBackupTarget()?.bucket ?? '';
    const snapshot: Record<string, unknown> = { ...database };
    delete snapshot.project;
    for (const f of SECRET_FIELDS) if (f !== 'dbPassword') delete snapshot[f];
    const row = await this.prisma.deletedDatabase.upsert({
      where: { id: database.id },
      create: {
        id: database.id,
        projectId: database.projectId,
        organizationId: database.project.organizationId,
        environmentId: database.environmentId,
        name: database.name,
        namespace: database.namespace,
        clusterName: database.clusterName,
        backupServerName: database.backupServerName || database.clusterName,
        destinationPath: `s3://${bucket}/${database.namespace}/${database.clusterName}`,
        pgMajor: database.pgMajor ?? 17,
        snapshot: JSON.parse(
          JSON.stringify(snapshot, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
        ) as Prisma.InputJsonValue,
        reason: opts.reason,
        recoverableUntil: hasBackup ? (recoverableUntil ?? new Date()) : null,
        deletedBy: opts.deletedBy ?? null,
        purgeAfter: new Date(Date.now() + TRASH_RETENTION_MS)
      },
      update: {}
    });
    return row;
  }

  list(where: { projectId?: string; organizationId?: string }) {
    return this.prisma.deletedDatabase.findMany({
      where: { ...where, purgedAt: null, restoredAs: null },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        organizationId: true,
        environmentId: true,
        name: true,
        pgMajor: true,
        reason: true,
        recoverableUntil: true,
        deletedAt: true,
        deletedBy: true,
        purgeAfter: true
      }
    });
  }

  async get(id: string) {
    const row = await this.prisma.deletedDatabase.findUnique({ where: { id } });
    if (!row || row.purgedAt) throw new NotFoundException('Deleted database not found');
    return row;
  }

  async undelete(
    id: string,
    input: { name?: string; environmentId?: string },
    requestedBy?: string | null
  ) {
    const row = await this.get(id);
    if (row.restoredAs) throw new BadRequestException('This database was already brought back');
    if (!row.recoverableUntil) {
      throw new BadRequestException(
        'This database had no completed backup, so it cannot be brought back'
      );
    }
    const busy = await this.prisma.databaseOperation.findFirst({
      where: {
        kind: 'undelete',
        status: { in: ['pending', 'running'] },
        source: { path: ['trashId'], equals: id }
      },
      select: { id: true }
    });
    if (busy) throw new BadRequestException('This database is already being brought back');
    const snap = row.snapshot as Record<string, any>;
    const source: OperationSource = {
      databaseId: null,
      trashId: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      environmentId: row.environmentId,
      name: row.name,
      namespace: row.namespace,
      clusterName: row.clusterName,
      serverName: row.backupServerName,
      pgMajor: row.pgMajor,
      storageSize: snap.storageSize || '1Gi',
      replicas: snap.replicas ?? 1,
      cpuRequestMilli: snap.cpuRequestMilli ?? null,
      memoryRequestBytes: snap.memoryRequestBytes ?? null,
      pgParameters: snap.pgParameters ?? null,
      sharedPreloadLibs: snap.sharedPreloadLibs ?? null,
      dbName: snap.dbName,
      dbUser: snap.dbUser,
      dbPassword: snap.dbPassword,
      nodePoolId: snap.nodePoolId ?? null,
      placementOverride: snap.placementOverride ?? null
    };
    return this.operations.enqueue({
      kind: 'undelete',
      databaseId: null,
      source,
      target: { type: 'latest' },
      request: { name: input.name, environmentId: input.environmentId },
      requestedBy
    });
  }

  @Interval(60 * 60 * 1000)
  async purgeExpired() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.prisma.deletedDatabase.findMany({
        where: { purgeAfter: { lt: new Date() }, purgedAt: null, restoredAs: null },
        include: {
          project: {
            include: {
              organization: { omit: { backupR2AccessKey: false, backupR2SecretKey: false } }
            }
          }
        },
        take: 20
      });
      const dbs = await this.databases();
      for (const row of due) {
        const busy = await this.prisma.databaseOperation.findFirst({
          where: {
            kind: 'undelete',
            status: { in: ['pending', 'running'] },
            source: { path: ['trashId'], equals: row.id }
          },
          select: { id: true }
        });
        if (busy) continue;
        try {
          const scoped = await dbs.mintScopedR2(row.project.organization, {
            organizationId: row.organizationId,
            writePrefix: `${row.namespace}/${row.clusterName}/`,
            readPrefixes: [],
            purpose: 'database-purge',
            ttlMs: 60 * 60 * 1000
          });
          await dbs.purgeBackupObjects({
            namespace: row.namespace,
            clusterName: row.clusterName,
            r2ProxyAccessKey: scoped?.scopedKey ?? null,
            r2ProxySecret: scoped?.scopedKey ? scoped.r2.secretKey : null,
            project: { organization: row.project.organization }
          });
          if (scoped?.scopedKey) {
            await this.prisma.storageAccessKey.deleteMany({
              where: { accessKey: scoped.scopedKey }
            });
          }
          await this.prisma.deletedDatabase.update({
            where: { id: row.id },
            data: { purgedAt: new Date() }
          });
          this.logger.log(
            `purged the backups of deleted database ${row.name} (${row.namespace}/${row.clusterName})`
          );
        } catch (e: any) {
          this.logger.warn(`purging deleted database ${row.name} failed: ${k8sErrorMessage(e)}`);
        }
      }
      await this.prisma.storageAccessKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    } catch (e: any) {
      this.logger.warn(`trash purge failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }
}
