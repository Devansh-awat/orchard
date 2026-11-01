import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { platformBackupTarget } from '../instance-config/object-storage';

export const CATALOG_PREFIX = '_catalog';

export interface CatalogRow {
  id: string;
  name: string;
  projectId: string;
  environmentId: string | null;
  namespace: string | null;
  clusterName: string | null;
  backupServerName: string | null;
  backupMethod: string | null;
  pgMajor: number | null;
  storageSize: string | null;
  replicas: number | null;
  dbName: string;
  dbUser: string;
  project: { organizationId: string; organization: { backupR2Bucket: string | null } };
}

export interface TrashRow {
  id: string;
  name: string;
  projectId: string;
  organizationId: string;
  namespace: string;
  clusterName: string;
  backupServerName: string;
  destinationPath: string;
  pgMajor: number;
  deletedAt: Date;
  purgeAfter: Date;
}

export function buildCatalog(
  rows: CatalogRow[],
  trash: TrashRow[],
  platformBucket: string,
  now = new Date()
) {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    howToRestore:
      'Each entry is one CNPG archive: <bucket>/<namespace>/<clusterName>/<serverName>/{base,wals}. Recover it with a Cluster whose bootstrap.recovery.source points at an externalCluster with that destinationPath and serverName.',
    databases: rows
      .filter((r) => r.namespace && r.clusterName)
      .map((r) => {
        const bucket = r.project.organization.backupR2Bucket || platformBucket;
        return {
          id: r.id,
          name: r.name,
          organizationId: r.project.organizationId,
          projectId: r.projectId,
          environmentId: r.environmentId,
          namespace: r.namespace,
          clusterName: r.clusterName,
          serverName: r.backupServerName || r.clusterName,
          method: r.backupMethod || 'barman',
          pgMajor: r.pgMajor,
          storageSize: r.storageSize,
          replicas: r.replicas,
          dbName: r.dbName,
          dbUser: r.dbUser,
          bucket,
          destinationPath: `s3://${bucket}/${r.namespace}/${r.clusterName}`
        };
      }),
    deleted: trash.map((t) => ({
      id: t.id,
      name: t.name,
      organizationId: t.organizationId,
      projectId: t.projectId,
      namespace: t.namespace,
      clusterName: t.clusterName,
      serverName: t.backupServerName,
      pgMajor: t.pgMajor,
      destinationPath: t.destinationPath,
      deletedAt: t.deletedAt.toISOString(),
      purgeAfter: t.purgeAfter.toISOString()
    }))
  };
}

@Injectable()
export class DatabaseCatalogService {
  private readonly logger = new Logger(DatabaseCatalogService.name);

  private lastExport = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService
  ) {}

  @Interval(60 * 60 * 1000)
  async tick() {
    if (!this.leader.isLeader()) return;
    if (Date.now() - this.lastExport < 20 * 60 * 60 * 1000) return;
    await this.export()
      .then(() => {
        this.lastExport = Date.now();
      })
      .catch((e) => this.logger.warn(`database catalog export failed: ${e?.message ?? e}`));
  }

  async export(): Promise<{ key: string; databases: number } | null> {
    const target = platformBackupTarget();
    if (!target) return null;
    const [rows, trash] = await Promise.all([
      this.prisma.database.findMany({
        where: { mode: 'cnpg' },
        select: {
          id: true,
          name: true,
          projectId: true,
          environmentId: true,
          namespace: true,
          clusterName: true,
          backupServerName: true,
          backupMethod: true,
          pgMajor: true,
          storageSize: true,
          replicas: true,
          dbName: true,
          dbUser: true,
          project: {
            select: { organizationId: true, organization: { select: { backupR2Bucket: true } } }
          }
        }
      }),
      this.prisma.deletedDatabase.findMany({ where: { purgedAt: null, restoredAs: null } })
    ]);
    const catalog = buildCatalog(rows, trash, target.bucket);
    const body = JSON.stringify(catalog, null, 2);
    const s3 = new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      credentials: { accessKeyId: target.accessKey, secretAccessKey: target.secretKey },
      forcePathStyle: true
    });
    const day = catalog.generatedAt.slice(0, 10);
    for (const key of [
      `${CATALOG_PREFIX}/databases-${day}.json`,
      `${CATALOG_PREFIX}/databases-latest.json`
    ]) {
      await s3.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json'
        })
      );
    }
    this.logger.log(
      `exported a catalog of ${catalog.databases.length} databases to ${target.bucket}/${CATALOG_PREFIX}`
    );
    return { key: `${CATALOG_PREFIX}/databases-latest.json`, databases: catalog.databases.length };
  }
}
