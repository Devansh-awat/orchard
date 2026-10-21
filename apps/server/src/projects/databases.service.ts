import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ModuleRef } from '@nestjs/core';
import { DeploymentsService } from './deployments.service';
import { ResourceBindingsService } from './resource-bindings.service';
import { Prisma } from '@prisma/client';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { K8sCnpgService, normalizeBackupEndpointURL } from '../kubernetes/k8s-cnpg.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { PG_PARAM_BOUNDS } from '../kubernetes/pg-params';
import { deriveDbTuning } from '../kubernetes/db-tuning';
import { parameterDrift } from '../kubernetes/cnpg-spec-sync';
import { R2ProxyService } from '../kubernetes/r2-proxy.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { QuotasService } from '../quotas/quotas.service';
import { NodesService } from '../nodes/nodes.service';
import { buildPlacement } from '../kubernetes/kubernetes.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { BackupSyncService } from './backup-sync.service';
import {
  formatSlug,
  redactDatabaseForViewer,
  stripR2ProxyCreds,
  truncateK8sName,
  parseStorageSize,
  formatBytes,
  toQuartzCron,
  DEFAULT_BACKUP_CRON,
  GIB
} from './projects.utils';
import { NotificationsService } from '../notifications/notifications.service';
import { platformBackupTarget } from '../instance-config/object-storage';
import { LeaseService } from '../coordination/lease.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { signalEnvironmentEnvChanged } from '../env/env-change-signal';
import type { ClusterSnapshot, DbStats, MirroredDbPod } from '../kubernetes/cnpg-status';

/** The org fields that locate a managed database's backups in R2. */
export type OrgR2 = {
  backupR2Endpoint: string | null;
  backupR2Bucket: string | null;
  backupR2Region: string | null;
  backupR2AccessKey: string | null;
  backupR2SecretKey: string | null;
};

const BACKUP_RECONCILE_MS = 10 * 60_000;

export type ProvisioningStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface ProvisioningStep {
  id: string;
  label: string;
  description: string;
  status: ProvisioningStepStatus;
  detail?: string;
}

@Injectable()
export class DatabasesService {
  private readonly logger = new Logger(DatabasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly r2Proxy: R2ProxyService,
    private readonly usersService: UsersService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
    private readonly environments: EnvironmentsService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
    @Inject(forwardRef(() => NodesService))
    private readonly nodesService: NodesService,
    private readonly backupSync: BackupSyncService,
    private readonly notifications: NotificationsService,
    private readonly instanceConfig: InstanceConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly bindings: ResourceBindingsService,
    private readonly crypto: SecretCryptoService
  ) {}

  private revealPassword<T extends { dbPassword: string }>(row: T): T {
    return { ...row, dbPassword: this.crypto.open(row.dbPassword) };
  }

  // Resolve a database cluster's placement: org hostname allow/deny + assigned
  // node pool + superadmin override, merged into affinity + tolerations that
  // createCnpgCluster feeds into spec.affinity.
  private async resolveDatabasePlacement(
    organizationId: string,
    nodePoolId: string | null | undefined,
    placementOverride: unknown
  ) {
    const org = await this.nodesService.getPlacementForOrg(organizationId);
    const pool = await this.nodesService.resolvePool(nodePoolId ?? null);
    const override = this.nodesService.toPlacementOverride(placementOverride ?? null);
    return buildPlacement({
      allowedNodes: org.allowedNodes,
      deniedNodes: org.deniedNodes,
      pool,
      override
    });
  }

  // ── Database (PostgreSQL) Management ──

  // Default major for new clusters. Imports from a newer source
  // auto-provision at the source's major (capped at MAX_PG_MAJOR) because
  // CNPG's import runs pg_dump from the target image, and an older pg_dump
  // cannot dump a newer server.
  private readonly DEFAULT_PG_MAJOR = 17;

  private readonly MAX_PG_MAJOR = 18;

  // pg_restore under CNPG's import-optimized config OOMs at small memory
  // limits, so imports provision at least this much and settle back down
  // once bootstrap completes (ImportSettleService).
  private readonly IMPORT_BOOST_CPU_MILLI = 500;

  private readonly IMPORT_BOOST_MEMORY_BYTES = 1024 * 1024 * 1024;

  // Ceiling on CNPG instances per cluster (1 primary + N-1 standbys). Every
  // extra instance is a full pod plus its own PVC, so self-hosters running on
  // a small cluster will want this lower — and a big one, higher.
  get maxReplicas(): number {
    const raw = Number.parseInt(process.env.MAX_DATABASE_REPLICAS || '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 5;
  }

  /** Validate a user-supplied replica count against the instance ceiling. */
  resolveReplicas(input: number | null | undefined): number {
    if (input == null) return 1;
    const n = Number(input);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException('Replicas must be a whole number of at least 1');
    }
    if (n > this.maxReplicas) {
      throw new BadRequestException(`Replicas cannot exceed ${this.maxReplicas} on this instance`);
    }
    return n;
  }

  /**
   * Build the R2/backup config object that gets handed to the in-cluster
   * barman sidecar. When the r2-proxy is enabled we mint a per-cluster fake
   * AK/SK, register a binding with the proxy ConfigMap, and tell the cluster
   * to talk to the proxy instead of real R2 — so real R2 credentials never
   * land in the tenant's namespace.
   */
  hasBackupStorage(org: Partial<OrgR2> | null | undefined): boolean {
    return this.describeBackupRoute(org) !== null;
  }

  private describeBackupRoute(
    org: Partial<OrgR2> | null | undefined
  ): { endpoint: string; bucket: string; region: string; viaProxy: boolean; own: boolean } | null {
    const own = Boolean(
      org?.backupR2Endpoint &&
      org?.backupR2Bucket &&
      org?.backupR2AccessKey &&
      org?.backupR2SecretKey
    );
    const platform = platformBackupTarget();
    const bucket = own ? org!.backupR2Bucket! : platform?.bucket;
    if (!bucket) return null;
    const viaProxy =
      this.r2Proxy.isEnabled() && (!own || Boolean(platform && bucket === platform.bucket));
    const endpoint = viaProxy
      ? this.r2Proxy.getEndpoint()
      : own
        ? org!.backupR2Endpoint!
        : platform!.endpoint;
    const region = (own && org?.backupR2Region) || 'auto';
    return { endpoint, bucket, region, viaProxy, own };
  }

  private async buildBackupR2Config(
    org: Partial<OrgR2> | null | undefined,
    namespace: string,
    clusterName: string
  ): Promise<{
    r2:
      | {
          endpoint: string;
          bucket: string;
          region: string;
          accessKey: string;
          secretKey: string;
        }
      | undefined;
    r2ProxyAccessKey: string | undefined;
    r2ProxySecret: string | undefined;
  }> {
    const route = this.describeBackupRoute(org);
    if (!route) {
      return { r2: undefined, r2ProxyAccessKey: undefined, r2ProxySecret: undefined };
    }

    if (route.viaProxy) {
      const minted = this.r2Proxy.mintCredentials();
      await this.r2Proxy.addBinding({
        accessKey: minted.accessKey,
        secret: minted.secret,
        bucket: route.bucket,
        prefix: `${namespace}/${clusterName}/`
      });
      return {
        r2: {
          endpoint: route.endpoint,
          bucket: route.bucket,
          region: route.region,
          accessKey: minted.accessKey,
          secretKey: minted.secret
        },
        r2ProxyAccessKey: minted.accessKey,
        r2ProxySecret: minted.secret
      };
    }

    if (route.own) {
      return {
        r2: {
          endpoint: route.endpoint,
          bucket: route.bucket,
          region: route.region,
          accessKey: org!.backupR2AccessKey!,
          secretKey: this.crypto.open(org!.backupR2SecretKey!)
        },
        r2ProxyAccessKey: undefined,
        r2ProxySecret: undefined
      };
    }

    const platform = platformBackupTarget()!;
    return {
      r2: {
        endpoint: platform.endpoint,
        bucket: platform.bucket,
        region: 'auto',
        accessKey: platform.accessKey,
        secretKey: platform.secretKey
      },
      r2ProxyAccessKey: undefined,
      r2ProxySecret: undefined
    };
  }

  private async validateImportSource(src: {
    host: string;
    port?: number;
    user: string;
    password: string;
    database: string;
    sslMode?: string;
  }): Promise<{ sourceSizeBytes: number | null; sourceMajor: number }> {
    const ssl = src.sslMode && src.sslMode !== 'disable' ? { rejectUnauthorized: false } : false;
    const client = new Client({
      host: src.host,
      port: src.port || 5432,
      user: src.user,
      password: src.password,
      database: src.database,
      ssl,
      connectionTimeoutMillis: 8000,
      statement_timeout: 5000,
      query_timeout: 5000
    });
    try {
      try {
        await client.connect();
      } catch (e: any) {
        const code = e?.code;
        const msg = e?.message || String(e);
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
          throw new BadRequestException(`Source database host not found: ${src.host}`);
        }
        if (code === 'ECONNREFUSED') {
          throw new BadRequestException(
            `Source database refused connection at ${src.host}:${src.port || 5432}`
          );
        }
        if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
          throw new BadRequestException(
            `Timed out connecting to source database at ${src.host}:${src.port || 5432}`
          );
        }
        if (code === '28P01' || code === '28000') {
          throw new BadRequestException(
            'Source database rejected credentials (wrong user or password)'
          );
        }
        if (code === '3D000') {
          throw new BadRequestException(`Source database "${src.database}" does not exist`);
        }
        if (/self.signed|self-signed|certificate/i.test(msg)) {
          throw new BadRequestException(
            `Source database TLS error: ${msg}. Try appending ?sslmode=require to the URL.`
          );
        }
        throw new BadRequestException(`Cannot reach source database: ${msg}`);
      }

      let versionNum: number | null = null;
      try {
        const r = await client.query('SHOW server_version_num');
        versionNum = Number(r.rows?.[0]?.server_version_num);
      } catch (e: any) {
        throw new BadRequestException(
          `Failed to query source database version: ${e?.message || e}`
        );
      }
      if (!versionNum || Number.isNaN(versionNum)) {
        throw new BadRequestException('Could not determine source PostgreSQL version');
      }
      const sourceMajor = Math.floor(versionNum / 10000);
      if (sourceMajor > this.MAX_PG_MAJOR) {
        throw new BadRequestException(
          `Source PostgreSQL major version (${sourceMajor}) is newer than the newest version the platform supports (${this.MAX_PG_MAJOR}); import is not supported yet.`
        );
      }

      let sourceSizeBytes: number | null = null;
      try {
        const r = await client.query('SELECT pg_database_size(current_database()) AS size');
        const size = Number(r.rows?.[0]?.size);
        if (Number.isFinite(size) && size > 0) sourceSizeBytes = size;
      } catch {
        // Providers that deny pg_database_size shouldn't block the import;
        // the storage guard just doesn't apply.
      }
      return { sourceSizeBytes, sourceMajor };
    } finally {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }

  private generatePassword(length = 24): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(length);
    return Array.from(bytes as Buffer, (b: number) => chars[b % chars.length]).join('');
  }

  async createDatabase(
    projectId: string,
    data: {
      name: string;
      storageSize?: string;
      templateInstanceId?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      restoreFromUrl?: string;
      pgMajor?: number;
      replicas?: number | null;
      nodePoolId?: string | null;
      placementOverride?: unknown;
      environmentId?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true }
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    await this.authz.requireProjectEdit(project.id, user.id, 'create databases');

    const nameInput = String(data.name || '').trim();
    if (!nameInput) throw new BadRequestException('Database name is required');

    const slug = formatSlug(nameInput);
    if (!slug) throw new BadRequestException('Invalid database name');

    // Generate unique db name from org-project-dbname
    const orgSlug = project.organization.slug.replace(/-/g, '_');
    const projSlug = project.slug.replace(/-/g, '_');
    const nameSlug = slug.replace(/-/g, '_');
    const fullDbName = `${orgSlug}_${projSlug}_${nameSlug}`;
    // PostgreSQL identifiers are limited to 63 characters; dbUser has "u_" prefix so max 61 for the base
    const maxLen = 61;
    const dbBase = fullDbName.length > maxLen ? fullDbName.substring(0, maxLen) : fullDbName;
    const dbName = dbBase;
    const dbUser = `u_${dbBase}`;
    const dbPassword = this.generatePassword();

    // Resolve the target environment (explicit id, or the project default) so
    // the database is scoped to it. The database keeps its own (CNPG) namespace.
    const dbEnv = await this.environments.resolveEnvironment(projectId, data.environmentId);

    // Check uniqueness in our records (now per environment)
    const existing = await this.prisma.database.findFirst({
      where: { environmentId: dbEnv?.id ?? undefined, projectId, name: nameInput }
    });
    if (existing)
      throw new BadRequestException('A database with this name already exists in this environment');

    const dbNameExists = await this.prisma.database.findUnique({
      where: { dbName }
    });
    if (dbNameExists)
      throw new BadRequestException('A database with this identifier already exists');

    // New databases get a dedicated CNPG Cluster in the project namespace.
    // K8s resource name must match DNS-1123 (lowercase, hyphens, ≤53 chars to leave room for suffixes).
    const clusterName = `pg-${formatSlug(nameInput).substring(0, 48)}`.replace(/^-+|-+$/g, '');
    const namespace = project.namespace;

    const org = await this.prisma.organization.findUnique({
      where: { id: project.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    const { r2, r2ProxyAccessKey, r2ProxySecret } = await this.buildBackupR2Config(
      org,
      namespace,
      clusterName
    );

    const sizeRaw = typeof data.storageSize === 'string' ? data.storageSize.trim() : '';
    const storageSize = /^\d+(Mi|Gi|Ti)$/.test(sizeRaw) ? sizeRaw : '1Gi';

    let importFrom:
      | {
          host: string;
          port?: number;
          user: string;
          password: string;
          database: string;
          sslMode?: string;
        }
      | undefined;
    const restoreUrlRaw = typeof data.restoreFromUrl === 'string' ? data.restoreFromUrl.trim() : '';
    if (restoreUrlRaw) {
      try {
        const u = new URL(restoreUrlRaw);
        if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
          throw new Error('protocol must be postgres:// or postgresql://');
        }
        const sourceDb = u.pathname.replace(/^\//, '');
        if (!u.hostname || !u.username || !sourceDb) {
          throw new Error('URL must include host, user, and database');
        }
        importFrom = {
          host: u.hostname,
          port: u.port ? Number(u.port) : 5432,
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password || ''),
          database: sourceDb,
          sslMode: u.searchParams.get('sslmode') || undefined
        };
      } catch (e: any) {
        throw new BadRequestException(`Invalid restore URL: ${e?.message || 'parse error'}`);
      }
    }

    let pgMajor = this.DEFAULT_PG_MAJOR;
    if (data.pgMajor !== undefined && data.pgMajor !== null) {
      const requested = Number(data.pgMajor);
      if (!Number.isInteger(requested) || requested < 13 || requested > this.MAX_PG_MAJOR) {
        throw new BadRequestException(
          `Unsupported PostgreSQL version. Choose a major between 13 and ${this.MAX_PG_MAJOR}.`
        );
      }
      pgMajor = requested;
    }
    if (importFrom) {
      const { sourceSizeBytes, sourceMajor } = await this.validateImportSource(importFrom);
      pgMajor = Math.max(pgMajor, sourceMajor);
      // CNPG's microservice import writes the pg_dump onto the same volume the
      // data is restored into, so the PVC has to hold both at once.
      if (sourceSizeBytes) {
        const storageBytes = parseStorageSize(storageSize);
        const requiredBytes = sourceSizeBytes * 2;
        if (storageBytes != null && storageBytes < requiredBytes) {
          const suggestedGi = Math.max(1, Math.ceil(requiredBytes / GIB));
          throw new BadRequestException(
            `The source database is ${formatBytes(sourceSizeBytes)}, and the import needs room for both the dump and the restored data on the same volume. Choose at least ${suggestedGi}Gi of storage.`
          );
        }
      }
    }

    const replicas = this.resolveReplicas(data.replicas);

    const dbResources = await this.quotasService.resolvePodResources(
      projectId,
      {
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes ?? null
      },
      'postgres'
    );
    const provisionResources = importFrom
      ? {
          cpuMilli: Math.max(dbResources.cpuMilli, this.IMPORT_BOOST_CPU_MILLI),
          memoryBytes: Math.max(dbResources.memoryBytes, this.IMPORT_BOOST_MEMORY_BYTES)
        }
      : { cpuMilli: dbResources.cpuMilli, memoryBytes: dbResources.memoryBytes };
    const importBoosted =
      provisionResources.cpuMilli !== dbResources.cpuMilli ||
      provisionResources.memoryBytes !== dbResources.memoryBytes;

    // Each instance is a full pod at the resolved size, so a 3-replica cluster
    // bills three times over against the org cap and the owner's allowance.
    const provisionTotal = {
      cpuMilli: provisionResources.cpuMilli * replicas,
      memoryBytes: provisionResources.memoryBytes * replicas
    };

    try {
      await this.quotasService.enforceOrgCapForNewPod(project.organizationId, provisionTotal);
      await this.quotasService.enforceMemberAllowanceForNewPod(
        project.organizationId,
        project.ownerId,
        provisionTotal
      );
    } catch (e: any) {
      if (importBoosted) {
        throw new BadRequestException(
          `Importing a database temporarily provisions it with ${this.IMPORT_BOOST_CPU_MILLI}m CPU / ${formatBytes(this.IMPORT_BOOST_MEMORY_BYTES)} memory while the migration runs (it scales back down afterwards), and your quota can't fit that right now. ${e?.message || ''}`.trim()
        );
      }
      throw e;
    }
    await this.quotasService.applyProjectQuota(projectId).catch((err) => {
      console.error('[Projects] applyProjectQuota (db) failed:', err);
    });

    await this.nodesService.assertPoolAssignable({
      nodePoolId: data.nodePoolId,
      placementOverride: data.placementOverride,
      userId: user.id
    });
    const dbPlacement = await this.resolveDatabasePlacement(
      project.organizationId,
      data.nodePoolId ?? null,
      data.placementOverride ?? null
    );

    let host: string;
    let port: number;
    try {
      ({ host, port } = await this.k8sCnpg.createCnpgCluster({
        namespace,
        clusterName,
        dbName,
        dbUser,
        dbPassword,
        storageSize,
        r2,
        resources: provisionResources,
        instances: replicas,
        placement: dbPlacement,
        importFrom,
        imageName: `ghcr.io/cloudnative-pg/postgresql:${pgMajor}`
      }));
    } catch (e) {
      if (r2ProxyAccessKey) {
        try {
          await this.r2Proxy.removeBinding(r2ProxyAccessKey);
        } catch (cleanupErr: any) {
          console.warn(
            `[R2Proxy] Failed to remove binding ${r2ProxyAccessKey} after createCnpgCluster failure: ${cleanupErr?.message}`
          );
        }
      }
      throw e;
    }

    let database;
    try {
      database = await this.prisma.database.create({
        data: {
          projectId,
          environmentId: dbEnv?.id ?? null,
          name: nameInput,
          dbName,
          dbUser,
          dbPassword: this.crypto.seal(dbPassword),
          status: 'provisioning',
          mode: 'cnpg',
          pgMajor,
          namespace,
          clusterName,
          storageSize,
          replicas,
          cpuRequestMilli: data.cpuRequestMilli ?? null,
          memoryRequestBytes:
            data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
          importBoosted,
          host,
          port,
          createdBy: user.id,
          templateInstanceId: data.templateInstanceId ?? null,
          backupScheduleCron: r2 ? DEFAULT_BACKUP_CRON : null,
          nodePoolId: data.nodePoolId ?? null,
          placementOverride: (data.placementOverride ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          r2ProxyAccessKey: r2ProxyAccessKey ?? null,
          r2ProxySecret: r2ProxySecret ?? null
        },
        include: {
          creator: {
            select: { id: true, email: true, username: true, firstName: true, lastName: true }
          }
        }
      });
    } catch (e) {
      try {
        await this.k8sCnpg.deleteScheduledBackup(namespace, clusterName);
      } catch {
        /* ignore */
      }
      try {
        await this.k8sNetwork.unexposeCnpgCluster(namespace, clusterName);
      } catch {
        /* ignore */
      }
      try {
        await this.k8sCnpg.deleteCnpgCluster(namespace, clusterName);
      } catch {
        /* ignore */
      }
      if (r2ProxyAccessKey) {
        try {
          await this.r2Proxy.removeBinding(r2ProxyAccessKey);
        } catch (cleanupErr: any) {
          console.warn(
            `[R2Proxy] Failed to remove binding ${r2ProxyAccessKey} after createDatabase rollback: ${cleanupErr?.message}`
          );
        }
      }
      throw e;
    }

    // Not immediate: the cluster is still bootstrapping, and a base backup
    // fired against a primary that has not come up yet just fails. The first
    // scheduled run is well inside the retention window.
    if (r2) {
      this.k8sCnpg
        .upsertScheduledBackup(namespace, clusterName, toQuartzCron(DEFAULT_BACKUP_CRON))
        .catch((e) => {
          this.logger.warn(
            `[DB/backup] default schedule for ${namespace}/${clusterName} failed: ${k8sErrorMessage(e)}`
          );
        });
    }

    void this.audit.log({
      action: 'database.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: { mode: 'cnpg', storageSize, replicas }
    });

    return stripR2ProxyCreds(this.revealPassword(database as any));
  }

  private async mirroredPodsFor(ids: string[]): Promise<Map<string, MirroredDbPod[]>> {
    const out = new Map<string, MirroredDbPod[]>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.databasePod
      .findMany({
        where: { databaseId: { in: ids } },
        select: {
          databaseId: true,
          status: true,
          restartCount: true,
          ready: true,
          lastTerminationReason: true,
          lastExitCode: true,
          lastTerminatedAt: true,
          updatedAt: true
        }
      })
      .catch(() => []);
    for (const { databaseId, ...pod } of rows) {
      const list = out.get(databaseId);
      if (list) list.push(pod);
      else out.set(databaseId, [pod]);
    }
    return out;
  }

  private async mirroredClusterPods(databaseId: string): Promise<any[]> {
    const objects = await this.prisma.k8sObject.findMany({
      where: { shard: 'cnpg', kind: 'Pod', databaseId },
      select: { manifest: true }
    });
    return objects.map(({ manifest }) => {
      const pod = manifest as any;
      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        status: pod.status?.phase,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        startTime: pod.status?.startTime,
        conditions: pod.status?.conditions,
        containerStatuses: pod.status?.containerStatuses?.map((container: any) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          state: container.state
        })),
        labels: pod.metadata?.labels,
        annotations: pod.metadata?.annotations
      };
    });
  }

  private async mirroredPods(databaseId: string): Promise<MirroredDbPod[]> {
    return (await this.mirroredPodsFor([databaseId])).get(databaseId) ?? [];
  }

  async getDatabase(databaseId: string, canEdit = true, userId?: string, skipLive = false) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: { include: { organization: true } },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true }
        }
      }
    });

    if (!database) throw new NotFoundException('Database not found');

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(database.projectId, userId);
    }

    let liveStatus: any;
    let pods: any[] = [];
    if (skipLive) {
      ({ liveStatus, pods } = { liveStatus: undefined, pods: [] });
    } else if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      // The CNPG informer keeps these rows current and pushes database.changed
      // over SSE, so they are both cheaper and fresher than asking the
      // apiserver on every request. Null means the informer has not seen this
      // cluster yet (brand new, or a cold start), and getCnpgClusterStatus
      // falls back to a live pod listing.
      const mirrored = await this.mirroredPods(database.id);
      liveStatus = await this.k8sCnpg.getCnpgClusterStatus(
        database.namespace,
        database.clusterName,
        database.dbName,
        mirrored,
        clusterMirror(database)
      );
      pods = await this.mirroredClusterPods(database.id);

      // Reconcile stored status with live cluster state.
      // 'restarting' flips to 'ready' once the new pod becomes ready — same path
      // as initial provisioning, just from a different starting state.
      if (liveStatus.ready && database.status !== 'ready' && database.status !== 'restoring') {
        try {
          await this.prisma.database.update({
            where: { id: database.id },
            data: { status: 'ready' }
          });
          database.status = 'ready';
        } catch {
          /* ignore */
        }
      } else if (!liveStatus.exists && database.status !== 'error') {
        try {
          await this.prisma.database.update({
            where: { id: database.id },
            data: { status: 'error' }
          });
          database.status = 'error';
        } catch {
          /* ignore */
        }
      }
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      liveStatus = await this.k8sCnpg.getPostgresContainerStatus(
        database.namespace,
        database.containerName,
        database.dbName,
        database.dbUser
      );
      try {
        const podData = await this.k8sWorkload.getDeploymentPods(
          database.containerName,
          database.namespace
        );
        pods = podData?.pods || [];
      } catch {
        /* ignore */
      }
    } else {
      liveStatus = await this.k8sCnpg.getPostgresDatabaseStatus(database.dbName);
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: database.project.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    const backupsEnabled = Boolean(
      (database.mode === 'cnpg' || database.mode === 'container') &&
      ((org?.backupR2Endpoint &&
        org?.backupR2Bucket &&
        org?.backupR2AccessKey &&
        org?.backupR2SecretKey) ||
        platformBackupTarget())
    );

    const dbPassword = this.crypto.open(database.dbPassword);
    let publicHostname: string | null = null;
    let publicConnectionString: string | null = null;
    if (
      database.publicEnabled &&
      database.publicIp &&
      database.publicPort &&
      database.mode === 'cnpg' &&
      database.clusterName &&
      database.namespace
    ) {
      publicHostname =
        this.k8sCnpg.publicTlsHostname(database.namespace!, database.clusterName) || null;
      publicConnectionString = publicHostname
        ? `postgresql://${database.dbUser}:${dbPassword}@${publicHostname}:${database.publicPort}/${database.dbName}?sslmode=verify-full&sslrootcert=system`
        : `postgresql://${database.dbUser}:${dbPassword}@${database.publicIp}:${database.publicPort}/${database.dbName}?sslmode=require`;
      if (publicHostname) {
        // Opportunistically refresh the local TLS secret copy if cert-manager rotated it.
        try {
          await this.k8sCnpg.syncPublicTlsSecret(database.namespace);
        } catch {
          /* ignore */
        }
      }
    }

    // All three exist for any CNPG cluster; on a single-instance one -ro simply
    // has no endpoints behind it, which the UI shows as inactive rather than
    // hiding, since it goes live the moment a standby joins.
    const endpoints =
      database.mode === 'cnpg' && database.clusterName && database.namespace
        ? this.k8sCnpg.clusterEndpoints(database.namespace, database.clusterName)
        : null;

    const result: any = {
      ...database,
      dbPassword,
      connectionString: `postgresql://${database.dbUser}:${dbPassword}@${database.host}:${database.port}/${database.dbName}`,
      internalHost: `${database.host}:${database.port}`,
      endpoints,
      maxReplicas: this.maxReplicas,
      publicHostname,
      publicConnectionString,
      liveStatus,
      backupsEnabled,
      pods
    };
    if (!canEdit) {
      return redactDatabaseForViewer(result);
    }
    // R2 proxy backup credentials are infrastructure secrets — strip from
    // user-facing returns for editors/members too. Only admins of the org
    // (and the in-cluster provisioning path that reads prisma directly)
    // should ever see them.
    return stripR2ProxyCreds(result);
  }

  // The slow half of getDatabase: live cluster state, pod list, and the
  // stored-status reconcile. Split out so the page can render from row data
  // immediately and fill this in when it arrives (multi-second k8s
  // roundtrips, including pod execs for size/connections).
  async getDatabaseLive(databaseId: string, userId?: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        mode: true,
        namespace: true,
        clusterName: true,
        containerName: true,
        dbName: true,
        dbUser: true,
        status: true,
        projectId: true,
        clusterStatus: true,
        clusterSyncedAt: true,
        sizeBytes: true,
        connections: true,
        statsAt: true,
        volumeUsedBytes: true,
        volumeCapacityBytes: true,
        walPendingSegments: true
      }
    });
    if (!database) throw new NotFoundException('Database not found');
    if (userId) {
      await this.authz.requireProjectView(database.projectId, userId);
    }

    let liveStatus: any;
    let pods: any[] = [];
    let status = database.status;
    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      liveStatus = await this.k8sCnpg.getCnpgClusterStatus(
        database.namespace,
        database.clusterName,
        database.dbName,
        await this.mirroredPods(database.id),
        clusterMirror(database)
      );
      try {
        const podList = await this.k8sWorkload.listPods(database.namespace);
        pods = (podList?.pods || []).filter(
          (p: any) => p.labels?.['cnpg.io/cluster'] === database.clusterName
        );
      } catch {
        /* ignore */
      }
      if (liveStatus.ready && status !== 'ready' && status !== 'restoring') {
        try {
          await this.prisma.database.update({
            where: { id: database.id },
            data: { status: 'ready' }
          });
          status = 'ready';
        } catch {
          /* ignore */
        }
      } else if (!liveStatus.exists && status !== 'error') {
        try {
          await this.prisma.database.update({
            where: { id: database.id },
            data: { status: 'error' }
          });
          status = 'error';
        } catch {
          /* ignore */
        }
      }
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      liveStatus = await this.k8sCnpg.getPostgresContainerStatus(
        database.namespace,
        database.containerName,
        database.dbName,
        database.dbUser
      );
      try {
        const podData = await this.k8sWorkload.getDeploymentPods(
          database.containerName,
          database.namespace
        );
        pods = podData?.pods || [];
      } catch {
        /* ignore */
      }
    } else {
      liveStatus = await this.k8sCnpg.getPostgresDatabaseStatus(database.dbName);
    }

    return { liveStatus, pods, status };
  }

  async getDatabaseProvisioning(databaseId: string, userId?: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId }
    });
    if (!database) throw new NotFoundException('Database not found');

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(database.projectId, userId);
    }

    // Container-mode and external databases don't go through the CNPG step list.
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return {
        databaseId,
        status: database.status,
        mode: database.mode,
        done: database.status === 'ready',
        failed: database.status === 'error',
        hasImport: false,
        steps: [],
        events: []
      };
    }

    const k = await this.k8sCnpg.getCnpgProvisioningStatus(
      database.namespace,
      database.clusterName,
      { fetchImportLogs: true }
    );

    // Mirror the reconciliation that getDatabase() performs so polling this
    // endpoint alone is enough to flip 'provisioning' → 'ready' once CNPG is up.
    if (k.ready && database.status !== 'ready' && database.status !== 'restoring') {
      try {
        await this.prisma.database.update({
          where: { id: database.id },
          data: { status: 'ready' }
        });
        database.status = 'ready';
      } catch {
        /* ignore */
      }
    } else if (!k.exists && database.status !== 'error' && database.status !== 'provisioning') {
      try {
        await this.prisma.database.update({
          where: { id: database.id },
          data: { status: 'error' }
        });
        database.status = 'error';
      } catch {
        /* ignore */
      }
    }

    const podWaiting = k.instancePod?.waiting;
    const podStuck =
      podWaiting && /(Err|BackOff|Failed|InvalidImage)/i.test(podWaiting.reason || '');

    const steps: ProvisioningStep[] = [];

    let clusterStatus: ProvisioningStepStatus = 'running';
    if (k.exists) clusterStatus = 'done';
    else if (database.status === 'error') clusterStatus = 'error';

    steps.push({
      id: 'cluster',
      label: 'Cluster resource created',
      description: 'Registering the Postgres cluster with Kubernetes.',
      status: clusterStatus
    });

    let storageStatus: ProvisioningStepStatus = 'pending';
    if (k.pvc.bound) storageStatus = 'done';
    else if (k.pvc.exists || k.exists) storageStatus = 'running';

    steps.push({
      id: 'storage',
      label: 'Storage volume attached',
      description: 'Provisioning and binding the PersistentVolumeClaim.',
      status: storageStatus,
      detail: k.pvc.exists && !k.pvc.bound ? `PVC ${k.pvc.phase || 'Pending'}` : undefined
    });

    let podScheduledStatus: ProvisioningStepStatus = 'pending';
    if (k.instancePod?.scheduled) podScheduledStatus = 'done';
    else if (k.instancePod) podScheduledStatus = 'running';

    steps.push({
      id: 'pod-scheduled',
      label: 'Pod scheduled to a node',
      description: 'Kubernetes is placing the Postgres pod onto a worker.',
      status: podScheduledStatus,
      detail: k.instancePod?.nodeName ? `Scheduled on ${k.instancePod.nodeName}` : undefined
    });

    let podRunningStatus: ProvisioningStepStatus = 'pending';
    if (k.instancePod?.running) podRunningStatus = 'done';
    else if (podStuck) podRunningStatus = 'error';
    else if (k.instancePod?.scheduled) podRunningStatus = 'running';

    steps.push({
      id: 'pod-running',
      label: 'Postgres container running',
      description: 'Pulling the Postgres image and starting the container.',
      status: podRunningStatus,
      detail: podWaiting
        ? `${podWaiting.reason}${podWaiting.message ? `: ${podWaiting.message}` : ''}`
        : undefined
    });

    if (k.hasImport) {
      let importStatus: ProvisioningStepStatus = 'pending';
      if (k.importStatus === 'completed') importStatus = 'done';
      else if (k.importStatus === 'failed') importStatus = 'error';
      else if (k.importStatus === 'running') importStatus = 'running';

      steps.push({
        id: 'import',
        label: 'Migrating data from source database',
        description:
          importStatus === 'error' && k.importError
            ? k.importError
            : 'CloudNativePG is dumping the source DB and restoring into this cluster.',
        status: importStatus
      });
    }

    let readyStatus: ProvisioningStepStatus = 'pending';
    if (k.ready) readyStatus = 'done';
    else if (k.instancePod?.ready) readyStatus = 'running';

    steps.push({
      id: 'ready',
      label: 'Database accepting connections',
      description: 'Bootstrap is complete and the cluster is healthy.',
      status: readyStatus
    });

    // Promote the first non-done step to "running" if everything before it is
    // done — this gives the UI a clear "current" step even when CNPG hasn't
    // emitted intermediate signals yet.
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === 'pending') {
        const prevDone = steps.slice(0, i).every((s) => s.status === 'done');
        if (prevDone && !steps.some((s) => s.status === 'error')) {
          steps[i].status = 'running';
        }
        break;
      }
    }

    const failed =
      steps.some((s) => s.status === 'error') ||
      database.status === 'error' ||
      (k.hasImport && k.importStatus === 'failed');
    const done = k.ready && database.status === 'ready';

    return {
      databaseId,
      status: database.status,
      mode: database.mode,
      done,
      failed,
      phase: k.phase,
      hasImport: k.hasImport,
      importStatus: k.importStatus,
      importLogs: k.importLogs,
      steps,
      conditions: k.conditions,
      events: k.events,
      pod: k.instancePod,
      importPod: k.importPod
    };
  }

  async getProjectDatabases(projectId: string, canEdit = true, userId?: string) {
    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(projectId, userId);
    }
    const databases = await this.prisma.database.findMany({
      where: { projectId },
      include: {
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Lightweight liveStatus enrichment so the list view can surface OOM/crash
    // states (the persisted `status` says "ready" even while pods OOM-cycle).
    // Best-effort + parallel; failures fall through silently.
    const podsByDb = await this.mirroredPodsFor(databases.map((d) => d.id));
    const enriched = await Promise.all(
      databases.map(async (d: any) => {
        if (d.mode === 'cnpg' && d.namespace && d.clusterName) {
          try {
            const ls = await this.k8sCnpg.getCnpgClusterStatus(
              d.namespace,
              d.clusterName,
              d.dbName,
              podsByDb.get(d.id) ?? [],
              clusterMirror(d)
            );
            return { ...d, liveStatus: ls };
          } catch {
            return d;
          }
        }
        return d;
      })
    );

    if (!canEdit) {
      return enriched.map((d) => redactDatabaseForViewer(d as any));
    }
    // Strip R2 proxy backup credentials from editor returns as well — they
    // are infrastructure secrets, not user-facing data.
    return enriched.map((d) => stripR2ProxyCreds(this.revealPassword(d as any)));
  }

  async purgeBackupObjects(database: {
    namespace: string | null;
    clusterName: string | null;
    r2ProxyAccessKey: string | null;
    r2ProxySecret: string | null;
    project?: {
      organization?: {
        backupR2Endpoint: string | null;
        backupR2Bucket: string | null;
        backupR2Region: string | null;
        backupR2AccessKey: string | null;
        backupR2SecretKey: string | null;
      } | null;
    } | null;
  }): Promise<void> {
    const org = database.project?.organization;
    const platform = platformBackupTarget();
    const bucket = org?.backupR2Bucket ?? platform?.bucket;
    if (!database.namespace || !database.clusterName || !bucket) return;

    try {
      let endpoint: string | undefined;
      let accessKeyId: string | undefined;
      let secretAccessKey: string | undefined;
      if (this.r2Proxy.isEnabled() && database.r2ProxyAccessKey && database.r2ProxySecret) {
        endpoint = this.r2Proxy.getEndpoint();
        accessKeyId = database.r2ProxyAccessKey;
        secretAccessKey = database.r2ProxySecret;
      } else if (
        org?.backupR2Endpoint &&
        org.backupR2AccessKey &&
        org.backupR2SecretKey &&
        org.backupR2AccessKey !== 'proxy-managed'
      ) {
        endpoint = org.backupR2Endpoint;
        accessKeyId = org.backupR2AccessKey;
        secretAccessKey = this.crypto.open(org.backupR2SecretKey);
      } else if (platform) {
        endpoint = platform.endpoint;
        accessKeyId = platform.accessKey;
        secretAccessKey = platform.secretKey;
      }
      if (!endpoint || !accessKeyId || !secretAccessKey) return;

      const prefix = `${database.namespace}/${database.clusterName}/`;
      const s3 = new S3Client({
        endpoint,
        region: org?.backupR2Region || 'auto',
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true
      });

      try {
        let continuationToken: string | undefined;
        let deleted = 0;
        do {
          const listed = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: continuationToken
            })
          );
          const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
          for (const Key of keys) {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
            deleted += 1;
          }
          continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (continuationToken);
        if (deleted > 0) {
          this.logger.log(
            `[R2] Purged ${deleted} orphaned backup object(s) under ${bucket}/${prefix}`
          );
        }
      } finally {
        s3.destroy();
      }
    } catch (e: any) {
      this.logger.warn(
        `[R2] Failed to purge backup objects for ${database.namespace}/${database.clusterName}: ${e?.message ?? e}`
      );
    }
  }

  /**
   * Re-point every managed database in a project at the destination org's backup
   * storage after the project moves orgs. New base backups and WAL archiving flow
   * to the destination; existing backups stay exactly where they were taken, so
   * their restore records keep resolving and nothing is deleted or lost. When the
   * destination has no R2 configured, archiving is switched off so the database
   * stops writing into the old org's bucket — new backups pause until R2 is set
   * up in the destination. Best-effort; runs in the background after a move.
   */
  async repointProjectBackupsToOrg(projectId: string, destOrgId: string): Promise<void> {
    const destOrg = (await this.prisma.organization.findUnique({
      where: { id: destOrgId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    })) as OrgR2 | null;
    const databases = await this.prisma.database.findMany({
      where: { projectId },
      select: { id: true, mode: true, namespace: true, clusterName: true, r2ProxyAccessKey: true }
    });
    for (const db of databases) {
      if (db.mode !== 'cnpg' || !db.namespace || !db.clusterName) continue;
      try {
        await this.repointDatabaseBackups(db, destOrg);
      } catch (e: any) {
        this.logger.error(
          `[DB/move] backup re-point failed for ${db.namespace}/${db.clusterName}: ${e?.message ?? e}`
        );
      }
    }
  }

  private async repointDatabaseBackups(
    db: {
      id: string;
      namespace: string | null;
      clusterName: string | null;
      r2ProxyAccessKey: string | null;
    },
    destOrg: OrgR2 | null
  ): Promise<void> {
    if (!db.namespace || !db.clusterName) return;
    const previousProxyKey = db.r2ProxyAccessKey;
    const built = await this.buildBackupR2Config(destOrg, db.namespace, db.clusterName);
    if (!built.r2) {
      // Nowhere to archive to in the new org: stop writing into the old org's
      // bucket. Existing backups stay restorable; new backups pause until the
      // destination configures R2.
      if (await this.k8sCnpg.isCnpgBackupConfigured(db.namespace, db.clusterName)) {
        await this.k8sCnpg.disableCnpgBackup(db.namespace, db.clusterName);
        this.logger.log(
          `[DB/move] paused backups for ${db.namespace}/${db.clusterName}: destination org has no R2`
        );
      }
      if (this.r2Proxy.isEnabled() && previousProxyKey) {
        await this.r2Proxy.removeBinding(previousProxyKey).catch(() => {});
        await this.prisma.database.update({
          where: { id: db.id },
          data: { r2ProxyAccessKey: null, r2ProxySecret: null }
        });
      }
      return;
    }

    const { r2: destR2, r2ProxyAccessKey: destProxyKey, r2ProxySecret: destProxySecret } = built;

    await this.k8sCnpg.enableCnpgBackup(db.namespace, db.clusterName, destR2);
    if (destProxyKey) {
      await this.prisma.database.update({
        where: { id: db.id },
        data: { r2ProxyAccessKey: destProxyKey, r2ProxySecret: destProxySecret }
      });
      if (this.r2Proxy.isEnabled() && previousProxyKey && previousProxyKey !== destProxyKey) {
        await this.r2Proxy.removeBinding(previousProxyKey).catch(() => {});
      }
    }
    if (!destProxyKey && previousProxyKey) {
      await this.r2Proxy.removeBinding(previousProxyKey).catch(() => {});
      await this.prisma.database.update({
        where: { id: db.id },
        data: { r2ProxyAccessKey: null, r2ProxySecret: null }
      });
    }
    this.logger.log(
      `[DB/move] re-pointed backups for ${db.namespace}/${db.clusterName} to ${destR2.bucket}`
    );
  }

  /**
   * Every app bound to this database reads its credentials at inject time,
   * so after a host or password change the cluster env must be pushed
   * again. Failures are logged, not thrown: the database change itself has
   * already happened and is the thing the caller asked for.
   */
  private async followCredentialChange(databaseId: string, reason: string): Promise<string[]> {
    try {
      const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
      const names = await deployments.reapplyEnvForResource('database', databaseId);
      if (names.length > 0) {
        console.log(`[DB] ${reason}: re-applied env to ${names.join(', ')}`);
      }
      return names;
    } catch (e: any) {
      console.error(`[DB] ${reason}: re-applying env to bound apps failed: ${e?.message}`);
      return [];
    }
  }

  async rotateDatabasePassword(databaseId: string, clerkId: string, userData?: any) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.status !== 'ready' && database.status !== 'running') {
      throw new BadRequestException('The database has to be running to rotate its password');
    }
    const password = this.generatePassword();
    if (database.mode === 'cnpg') {
      if (!database.namespace || !database.clusterName) {
        throw new BadRequestException('Database is missing cluster metadata');
      }
      await this.k8sCnpg.setCnpgAppPassword(
        database.namespace,
        database.clusterName,
        database.dbName,
        database.dbUser,
        password
      );
    } else {
      await this.k8sCnpg.setSharedRolePassword(database.dbUser, password);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { dbPassword: this.crypto.seal(password) }
    });
    const reapplied = await this.followCredentialChange(database.id, 'password rotation');
    void this.audit.log({
      action: 'database.password.rotated',
      actorUserId: user.id,
      organizationId: database.project.organizationId,
      projectId: database.project.id,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: { reapplied: reapplied.join(',') || null }
    });
    return { success: true, reapplied };
  }

  async deleteDatabase(
    databaseId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: {
          include: {
            organization: { omit: { backupR2AccessKey: false, backupR2SecretKey: false } }
          }
        }
      }
    });
    if (!database) throw new NotFoundException('Database not found');

    await this.authz.requireProjectEdit(database.project.id, user.id, 'delete databases');

    const bound = await this.bindings.boundDeployments('database', database.id);
    if (bound.length > 0) {
      throw new BadRequestException(
        `${database.name} is still bound to ${bound.map((d) => d.name).join(', ')}. Unbind it there first.`
      );
    }

    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      try {
        await this.k8sCnpg.deleteScheduledBackup(database.namespace, database.clusterName);
      } catch {
        /* ignore */
      }
      try {
        await this.k8sNetwork.unexposeCnpgCluster(database.namespace, database.clusterName);
      } catch {
        /* ignore */
      }
      await this.k8sCnpg.deleteCnpgCluster(database.namespace, database.clusterName);
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      await this.k8sCnpg.deletePostgresContainer(database.namespace, database.containerName);
    } else {
      await this.k8sCnpg.deletePostgresDatabase(database.dbName, database.dbUser);
    }

    await this.purgeBackupObjects(database);

    if (database.r2ProxyAccessKey) {
      try {
        await this.r2Proxy.removeBinding(database.r2ProxyAccessKey);
      } catch (e: any) {
        console.warn(
          `[R2Proxy] Failed to remove binding ${database.r2ProxyAccessKey} during deleteDatabase: ${e?.message}`
        );
      }
    }

    const removed = await this.prisma.database.deleteMany({ where: { id: databaseId } });
    if (removed.count === 0) {
      return { success: true, message: `Database "${database.name}" deleted` };
    }

    this.notifications
      .purgeScope('database', databaseId)
      .catch((err) =>
        console.error(`[Projects] Failed to purge notification scope for ${databaseId}:`, err)
      );

    void this.audit.log({
      action: 'database.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name
    });

    return { success: true, message: `Database "${database.name}" deleted` };
  }

  async stopDatabase(databaseId: string, clerkId: string, userData?: any) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Stop and start require a CNPG-backed database');
    }
    await this.k8sCnpg.setCnpgHibernation(database.namespace, database.clusterName, true);
    await this.k8sCnpg
      .setScheduledBackupSuspended(database.namespace, database.clusterName, true)
      .catch((e: any) => {
        console.warn(
          `[DB/backup] could not suspend the schedule for ${database.clusterName}: ${e?.message ?? e}`
        );
      });
    await this.prisma.database.update({
      where: { id: databaseId },
      data: { status: 'stopped' }
    });
    void this.audit.log({
      action: 'database.stopped',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project?.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name
    });
    return { success: true };
  }

  async startDatabase(databaseId: string, clerkId: string, userData?: any) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Stop and start require a CNPG-backed database');
    }
    await this.k8sCnpg.setCnpgHibernation(database.namespace, database.clusterName, false);
    await this.k8sCnpg
      .setScheduledBackupSuspended(database.namespace, database.clusterName, false)
      .catch((e: any) => {
        console.warn(
          `[DB/backup] could not resume the schedule for ${database.clusterName}: ${e?.message ?? e}`
        );
      });
    await this.prisma.database.update({
      where: { id: databaseId },
      data: { status: 'restarting' }
    });
    void this.audit.log({
      action: 'database.started',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project?.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name
    });
    return { success: true };
  }

  /**
   * Scale a CNPG cluster to `replicas` total instances (1 primary + N-1 standbys).
   *
   * Quota is charged on the delta, the same way deployment scaling works: growing
   * by Δ instances adds Δ pods' worth of the cluster's per-instance resources to
   * the org cap and the project owner's allowance, while shrinking is always
   * allowed. The write lands before the K8s patch is acknowledged as complete,
   * so the row and the cluster agree even if the standby takes a while to join.
   */
  async updateDatabaseReplicas(
    databaseId: string,
    replicas: number,
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Replicas require a CNPG-backed database');
    }
    if (database.importBoosted) {
      throw new BadRequestException(
        'Replicas cannot be changed while the initial import is running. Try again once provisioning completes.'
      );
    }

    const desired = this.resolveReplicas(replicas);
    const current = Math.max(1, database.replicas ?? 1);
    if (desired === current) {
      return stripR2ProxyCreds(this.revealPassword(database as any));
    }

    const delta = desired - current;
    if (delta > 0) {
      const perInstance = await this.quotasService.resolvePodResources(
        database.projectId,
        {
          cpuRequestMilli: database.cpuRequestMilli ?? null,
          memoryRequestBytes:
            database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null
        },
        'postgres'
      );
      const requested = {
        cpuMilli: perInstance.cpuMilli * delta,
        memoryBytes: perInstance.memoryBytes * delta
      };
      await this.quotasService.enforceOrgCapForNewPod(database.project.organizationId, requested);
      await this.quotasService.enforceMemberAllowanceForNewPod(
        database.project.organizationId,
        database.project.ownerId,
        requested
      );
    }

    await this.k8sCnpg.updateCnpgClusterInstances(
      database.namespace,
      database.clusterName,
      desired
    );

    const updated = await this.prisma.database.update({
      where: { id: databaseId },
      data: { replicas: desired }
    });

    void this.audit.log({
      action: 'database.replicas.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name,
      metadata: { replicas: [current, desired] }
    });

    return stripR2ProxyCreds(this.revealPassword(updated as any));
  }

  async restartDatabase(databaseId: string, clerkId: string, userData?: any) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Restart requires a CNPG-backed database');
    }
    await this.k8sCnpg.rolloutRestartCnpgCluster(database.namespace, database.clusterName);
    await this.prisma.database.update({
      where: { id: databaseId },
      data: { status: 'restarting' }
    });
    void this.audit.log({
      action: 'database.restarted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project?.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name
    });
    return { success: true };
  }

  async renameDatabase(
    databaseId: string,
    name: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: {
          include: {
            organization: { omit: { backupR2AccessKey: false, backupR2SecretKey: false } }
          }
        }
      }
    });
    if (!database) throw new NotFoundException('Database not found');

    await this.authz.requireProjectEdit(database.project.id, user.id, 'rename databases');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    if (trimmed !== database.name) {
      const existing = await this.prisma.database.findFirst({
        where: {
          projectId: database.projectId,
          environmentId: database.environmentId,
          name: trimmed,
          id: { not: databaseId }
        }
      });
      if (existing) {
        throw new BadRequestException(
          'A database with this name already exists in this environment'
        );
      }
    }

    const updated = await this.prisma.database.update({
      where: { id: databaseId },
      data: { name: trimmed }
    });

    void this.audit.log({
      action: 'database.renamed',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: trimmed,
      metadata: { name: [database.name, trimmed] }
    });

    return this.revealPassword(updated);
  }

  // ── Database backup management ──

  /**
   * Make sure the cluster is actually archiving before anything tries to back
   * it up. Clusters provisioned before their org had backup storage carry no
   * `spec.backup`, and CNPG answers a ScheduledBackup or Backup against one of
   * those with a validation error, which is how "set a schedule" used to fail
   * for a third of the fleet. Returns true when archiving was just turned on.
   */
  private async ensureBackupsConfigured(database: {
    id: string;
    namespace: string | null;
    clusterName: string | null;
    r2ProxyAccessKey: string | null;
    project: { organizationId: string };
  }): Promise<boolean> {
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: database.project.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });

    if (await this.k8sCnpg.isCnpgBackupConfigured(database.namespace, database.clusterName)) {
      return false;
    }

    const { r2, r2ProxyAccessKey, r2ProxySecret } = await this.buildBackupR2Config(
      org,
      database.namespace,
      database.clusterName
    );
    if (!r2) {
      throw new BadRequestException(
        'No backup storage: configure it for this organization, or set a backup bucket on the instance'
      );
    }

    try {
      await this.k8sCnpg.enableCnpgBackup(database.namespace, database.clusterName, r2);
    } catch (e) {
      if (r2ProxyAccessKey) {
        await this.r2Proxy.removeBinding(r2ProxyAccessKey).catch(() => {});
      }
      throw e;
    }

    if (r2ProxyAccessKey) {
      const previous = database.r2ProxyAccessKey;
      await this.prisma.database.update({
        where: { id: database.id },
        data: { r2ProxyAccessKey, r2ProxySecret }
      });
      if (previous && previous !== r2ProxyAccessKey) {
        await this.r2Proxy.removeBinding(previous).catch(() => {});
      }
    }

    this.logger.log(
      `[DB/backup] enabled WAL archiving for ${database.namespace}/${database.clusterName}`
    );
    return true;
  }

  private defaultBackupsTimer?: ReturnType<typeof setInterval>;

  onApplicationBootstrap() {
    try {
      const leader = this.moduleRef.get(LeaderElectionService, { strict: false });
      leader?.onAcquired(() => {
        void this.reconcileDefaultBackups().catch(() => {});
      });
    } catch {
      setTimeout(() => this.reconcileDefaultBackups().catch(() => {}), 120_000).unref?.();
    }
    this.defaultBackupsTimer = setInterval(
      () => this.reconcileDefaultBackups().catch(() => {}),
      BACKUP_RECONCILE_MS
    );
    this.defaultBackupsTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.defaultBackupsTimer) clearInterval(this.defaultBackupsTimer);
  }

  private canRunClusterWide(): boolean {
    try {
      const lease = this.moduleRef.get(LeaseService, { strict: false });
      const leader = this.moduleRef.get(LeaderElectionService, { strict: false });
      return !!lease?.canCoordinate && !!leader?.isLeader();
    } catch {
      return false;
    }
  }

  async reconcileDefaultBackups(): Promise<{
    archived: number;
    repaired: number;
    scheduled: number;
    failed: number;
  } | null> {
    if (!this.canRunClusterWide()) return null;
    const rows = await this.prisma.database.findMany({
      where: { mode: 'cnpg', namespace: { not: null }, clusterName: { not: null } },
      select: {
        id: true,
        namespace: true,
        clusterName: true,
        r2ProxyAccessKey: true,
        backupScheduleCron: true,
        backupScheduleDisabled: true,
        project: { select: { organizationId: true } }
      }
    });
    const orgs = new Map<string, OrgR2 | null>();
    let archived = 0;
    let repaired = 0;
    let scheduled = 0;
    let failed = 0;
    for (const db of rows) {
      try {
        const one = await this.reconcileDatabaseBackup(db, orgs);
        if (one.archived) archived += 1;
        if (one.repaired) repaired += 1;
        if (one.scheduled) scheduled += 1;
      } catch (e: any) {
        if (e?.response?.statusCode === 404) continue;
        failed += 1;
        this.logger.warn(
          `[DB/backup] default backups for ${db.namespace}/${db.clusterName} not applied: ${e?.message || e}`
        );
      }
    }
    if (archived || repaired || scheduled || failed) {
      this.logger.log(
        `[DB/backup] defaults reconciled: ${archived} clusters now archiving, ${repaired} re-pointed, ${scheduled} schedules created, ${failed} failed`
      );
    }
    return { archived, repaired, scheduled, failed };
  }

  private async reconcileDatabaseBackup(
    db: {
      id: string;
      namespace: string | null;
      clusterName: string | null;
      r2ProxyAccessKey: string | null;
      backupScheduleCron: string | null;
      backupScheduleDisabled: boolean;
      project: { organizationId: string };
    },
    orgs: Map<string, OrgR2 | null>
  ): Promise<{ archived: boolean; repaired: boolean; scheduled: boolean }> {
    const out = { archived: false, repaired: false, scheduled: false };
    const namespace = db.namespace!;
    const clusterName = db.clusterName!;
    const orgId = db.project.organizationId;
    if (!orgs.has(orgId)) {
      orgs.set(
        orgId,
        await this.prisma.organization.findUnique({
          where: { id: orgId },
          omit: { backupR2AccessKey: false, backupR2SecretKey: false }
        })
      );
    }
    const org = orgs.get(orgId) ?? null;
    const route = this.describeBackupRoute(org);
    if (!route) return out;
    const state = await this.k8sCnpg.getCnpgBackupState(namespace, clusterName);
    if (!state.configured) {
      if (db.backupScheduleDisabled) return out;
      if (await this.ensureBackupsConfigured(db)) out.archived = true;
    } else if (this.backupTargetDrifted(state, route, db.r2ProxyAccessKey)) {
      await this.repointDatabaseBackups(db, org);
      out.repaired = true;
      this.logger.warn(
        `[DB/backup] re-pointed ${namespace}/${clusterName}: archiving target was ${state.endpointURL ?? 'unset'} with key ${state.secretAccessKeyId ?? 'missing'}, expected ${route.endpoint}`
      );
    }
    if (db.backupScheduleDisabled) return out;
    if (!(await this.k8sCnpg.hasScheduledBackup(namespace, clusterName))) {
      const cron = db.backupScheduleCron || DEFAULT_BACKUP_CRON;
      await this.k8sCnpg.upsertScheduledBackup(namespace, clusterName, toQuartzCron(cron));
      if (!db.backupScheduleCron) {
        await this.prisma.database.update({
          where: { id: db.id },
          data: { backupScheduleCron: cron }
        });
      }
      out.scheduled = true;
    }
    return out;
  }

  async repairBackupTarget(databaseId: string): Promise<boolean> {
    if (!this.canRunClusterWide()) return false;
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        mode: true,
        namespace: true,
        clusterName: true,
        r2ProxyAccessKey: true,
        backupScheduleCron: true,
        backupScheduleDisabled: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!db || db.mode !== 'cnpg' || !db.namespace || !db.clusterName) return false;
    const one = await this.reconcileDatabaseBackup(db, new Map());
    return one.archived || one.repaired;
  }

  private backupTargetDrifted(
    state: { endpointURL: string | null; secretAccessKeyId: string | null },
    route: { endpoint: string; viaProxy: boolean },
    proxyAccessKey: string | null
  ): boolean {
    if (!state.secretAccessKeyId) return true;
    if (state.endpointURL !== normalizeBackupEndpointURL(route.endpoint)) return true;
    return route.viaProxy && state.secretAccessKeyId !== proxyAccessKey;
  }

  async listDatabaseBackups(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(
      databaseId,
      clerkId,
      userData,
      { allowViewer: true }
    );

    const anyNewlyCompleted = await this.backupSync
      .reconcileDatabase(database, { ingest: true })
      .catch(() => false);
    if (anyNewlyCompleted) {
      await this.backupSync.pruneOldBackups({
        id: database.id,
        namespace: database.namespace,
        clusterName: database.clusterName
      });
    }

    return this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id },
      orderBy: { createdAt: 'desc' }
    });
  }

  async createDatabaseBackup(
    databaseId: string,
    data: { label?: string; type?: 'full' | 'diff' | 'incr' },
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg') {
      throw new BadRequestException(
        'Backups are only supported for CNPG-backed databases. Recreate this database to enable backups.'
      );
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    await this.ensureBackupsConfigured(database);

    await this.backupSync.pruneOldBackups({
      id: database.id,
      namespace: database.namespace,
      clusterName: database.clusterName
    });

    const backupName = truncateK8sName(
      (data.label || `backup-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, ''),
      63
    );

    const record = await this.prisma.databaseBackup.create({
      data: {
        databaseId: database.id,
        label: backupName,
        backupName,
        type: 'full',
        status: 'running',
        createdBy: user.id
      }
    });

    try {
      await this.k8sCnpg.createCnpgBackup(database.namespace, database.clusterName, backupName);
    } catch (e: any) {
      await this.prisma.databaseBackup.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: String(e?.message || e).substring(0, 2000)
        }
      });
      throw new BadRequestException(`Failed to start backup: ${e?.message || e}`);
    }

    void this.audit.log({
      action: 'database.backup.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database_backup',
      targetId: record.id,
      targetLabel: backupName,
      metadata: { database: database.name }
    });

    return record;
  }

  // ── Backup schedule (one cron per database) ──

  private isValidCron(expr: string): boolean {
    // CNPG accepts "quartz" 6-field cron ("seconds minutes hours day month weekday")
    // and also supports 5-field via the standard scheduler; we require 5 or 6 fields.
    const trimmed = expr.trim();
    if (!trimmed) return false;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return false;
    return parts.every((p) => /^[\d*/,\-?LW#]+$/.test(p));
  }

  async getBackupSchedule(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(
      databaseId,
      clerkId,
      userData,
      { allowViewer: true }
    );
    return { cron: database.backupScheduleCron || null };
  }

  async setBackupSchedule(
    databaseId: string,
    data: { cron: string },
    clerkId: string,
    userData?: any
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Scheduled backups require a CNPG-backed database');
    }
    const cron = (data.cron || '').trim();
    if (!this.isValidCron(cron)) {
      throw new BadRequestException(
        'Invalid cron expression. Expected 5 or 6 space-separated fields.'
      );
    }

    // Turning archiving on and waiting until 3am for the first base backup
    // would leave a window with WAL in the bucket and nothing to restore from,
    // so the first run happens now.
    const justEnabled = await this.ensureBackupsConfigured(database);

    const quartz = toQuartzCron(cron);
    await this.k8sCnpg.upsertScheduledBackup(database.namespace, database.clusterName, quartz, {
      immediate: justEnabled
    });
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: cron, backupScheduleDisabled: false }
    });
    return { cron };
  }

  async deleteBackupSchedule(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { success: true };
    }
    try {
      await this.k8sCnpg.deleteScheduledBackup(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/schedule] Failed to delete ScheduledBackup: ${k8sErrorMessage(e)}`);
    }
    // Stop archiving too. WAL keeps being shipped for as long as the backup
    // stanza is there, and with no base backup left to expire against, barman
    // can never prune any of it — that is the pile-up that filled the bucket.
    try {
      await this.k8sCnpg.disableCnpgBackup(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/schedule] Failed to disable WAL archiving: ${k8sErrorMessage(e)}`);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: null, backupScheduleDisabled: true }
    });
    return { success: true };
  }

  async restoreDatabaseBackup(
    databaseId: string,
    backupId: string | undefined,
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg') {
      throw new BadRequestException('Restore is only supported for CNPG-backed databases');
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    if (!backupId) throw new BadRequestException('backupId is required');

    const org = await this.prisma.organization.findUnique({
      where: { id: database.project.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    if (!this.hasBackupStorage(org)) {
      throw new BadRequestException(
        'No backup storage: configure it for this organization, or set a backup bucket on the instance'
      );
    }

    const backup = await this.prisma.databaseBackup.findUnique({ where: { id: backupId } });
    if (!backup || backup.databaseId !== database.id)
      throw new NotFoundException('Backup not found');
    if (backup.status !== 'completed') throw new BadRequestException('Backup is not completed yet');

    const oldClusterName = database.clusterName;
    const oldR2ProxyAccessKey = database.r2ProxyAccessKey;

    await this.prisma.database.update({
      where: { id: database.id },
      data: { status: 'restoring' }
    });

    void this.audit.log({
      action: 'database.backup.restored',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: { backupId, backupName: backup.backupName }
    });

    // Predetermine the restore cluster name so we can mint a r2-proxy binding
    // for it (when the proxy is enabled) BEFORE the cluster spins up. The
    // suffix matches the format used inside restoreCnpgCluster.
    const restoreSuffix = Date.now().toString(36);
    const predictedNewClusterName = truncateK8sName(`${oldClusterName}-r${restoreSuffix}`, 53);
    const restoreR2 = await this.buildBackupR2Config(
      org,
      database.namespace!,
      predictedNewClusterName
    );
    if (restoreR2.r2ProxyAccessKey) {
      await this.prisma.database.update({
        where: { id: database.id },
        data: {
          r2RestoreAccessKey: restoreR2.r2ProxyAccessKey,
          r2RestoreSecret: restoreR2.r2ProxySecret ?? null,
          r2RestoreClusterName: predictedNewClusterName
        }
      });
    }
    // The restore cluster used to be built with no resource block at all, which
    // left it on the namespace LimitRange default and gave the tuning below
    // nothing to derive from. Size it like the database it is replacing.
    const restoreResources = await this.quotasService.resolvePodResources(
      database.projectId,
      {
        cpuRequestMilli: database.cpuRequestMilli ?? null,
        memoryRequestBytes:
          database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null
      },
      'postgres'
    );

    const clearRestoreCredentials = {
      r2RestoreAccessKey: null,
      r2RestoreSecret: null,
      r2RestoreClusterName: null
    };
    let cutOver = false;
    (async () => {
      try {
        const { newClusterName, host, port } = await this.k8sCnpg.restoreCnpgCluster(
          database.namespace!,
          oldClusterName,
          backup.backupName,
          {
            dbName: database.dbName,
            dbUser: database.dbUser,
            dbPassword: this.crypto.open(database.dbPassword),
            storageSize: database.storageSize || '1Gi',
            parameters: (database.pgParameters as Record<string, string> | null) || undefined,
            sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || undefined,
            r2: restoreR2.r2,
            newClusterName: predictedNewClusterName,
            instances: database.replicas ?? 1,
            resources: restoreResources,
            backupCompression: database.backupCompression,
            imageName: `ghcr.io/cloudnative-pg/postgresql:${database.pgMajor ?? 17}`
          }
        );

        // Wait for the new cluster to come up healthy before cutting over.
        const deadline = Date.now() + 10 * 60 * 1000;
        let healthy = false;
        while (Date.now() < deadline) {
          await new Promise((r) => {
            setTimeout(r, 5000);
          });
          const status = await this.k8sCnpg.getCnpgClusterStatus(
            database.namespace!,
            newClusterName
          );
          if (status.exists && status.ready) {
            healthy = true;
            break;
          }
        }
        if (!healthy) {
          throw new Error('Restore cluster did not become healthy within timeout');
        }

        await this.prisma.database.update({
          where: { id: database.id },
          data: {
            clusterName: newClusterName,
            host,
            port,
            status: 'ready',
            r2ProxyAccessKey: restoreR2.r2ProxyAccessKey ?? null,
            r2ProxySecret: restoreR2.r2ProxySecret ?? null,
            ...clearRestoreCredentials
          }
        });
        cutOver = true;
        await this.followCredentialChange(database.id, 'restore');

        try {
          await this.k8sCnpg.deleteCnpgCluster(database.namespace!, oldClusterName);
        } catch (e: any) {
          console.error(`[DB] Failed to delete old cluster ${oldClusterName}: ${e?.message}`);
        }

        // Old cluster is gone — its proxy binding is no longer needed.
        if (oldR2ProxyAccessKey && oldR2ProxyAccessKey !== restoreR2.r2ProxyAccessKey) {
          try {
            await this.r2Proxy.removeBinding(oldR2ProxyAccessKey);
          } catch (cleanupErr: any) {
            console.warn(
              `[R2Proxy] Failed to remove old binding ${oldR2ProxyAccessKey} after restore: ${cleanupErr?.message}`
            );
          }
        }
      } catch (e: any) {
        console.error(`[DB] Restore failed: ${e?.message}`);
        if (cutOver) return;
        try {
          await this.k8sCnpg.deleteCnpgCluster(database.namespace!, predictedNewClusterName);
        } catch (cleanupErr: any) {
          console.warn(
            `[DB] Failed to remove restore cluster ${predictedNewClusterName}: ${cleanupErr?.message}`
          );
        }
        if (restoreR2.r2ProxyAccessKey) {
          try {
            await this.r2Proxy.removeBinding(restoreR2.r2ProxyAccessKey);
          } catch (cleanupErr: any) {
            console.warn(
              `[R2Proxy] Failed to remove new binding ${restoreR2.r2ProxyAccessKey} after restore failure: ${cleanupErr?.message}`
            );
          }
        }
        await this.prisma.database.update({
          where: { id: database.id },
          data: { status: 'error', ...clearRestoreCredentials }
        });
      }
    })();

    return {
      success: true,
      message:
        'Restore initiated — a new cluster will be provisioned from the backup and cut over when ready.'
    };
  }

  // ── Extensions ──

  // 15s TTL keeps refresh-hammering from stressing tenant pods; the read
  // itself is a single fixed-SQL exec against the tenant's own instance.
  private readonly queryStatsCache = new Map<string, { at: number; data: unknown }>();

  private readonly QUERY_STATS_TTL_MS = 15_000;

  async getDatabaseQueryStats(databaseId: string) {
    const database = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!database) throw new NotFoundException('Database not found');
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Query statistics require a CNPG-backed database');
    }
    const cached = this.queryStatsCache.get(databaseId);
    if (cached && Date.now() - cached.at < this.QUERY_STATS_TTL_MS) return cached.data;
    const data = await this.k8sCnpg.getQueryStats(
      database.namespace,
      database.clusterName,
      database.dbName
    );
    this.queryStatsCache.set(databaseId, { at: Date.now(), data });
    return data;
  }

  async resetDatabaseQueryStats(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Query statistics require a CNPG-backed database');
    }
    const result = await this.k8sCnpg.resetQueryStats(
      database.namespace,
      database.clusterName,
      database.dbName
    );
    this.queryStatsCache.delete(databaseId);
    return result;
  }

  async listDatabaseExtensions(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(
      databaseId,
      clerkId,
      userData,
      { allowViewer: true }
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { extensions: [], sharedPreloadLibraries: [] };
    }
    const extensions = await this.k8sCnpg.listCnpgExtensions(
      database.namespace,
      database.clusterName,
      database.dbName
    );
    return {
      extensions,
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || []
    };
  }

  async installDatabaseExtension(
    databaseId: string,
    data: { name: string; addToPreload?: boolean },
    clerkId: string,
    userData?: any
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Extensions require a CNPG-backed database');
    }
    if (!data.name) throw new BadRequestException('name is required');

    // Untrusted Postgres procedural languages and FDWs give whoever can run
    // `CREATE EXTENSION` arbitrary code execution as the postgres OS user
    // inside the cluster pod (plperlu, plpython3u, plr) or filesystem reads
    // (file_fdw, adminpack) or arbitrary outbound TCP (dblink,
    // postgres_fdw). The tenant already runs in their own namespace and
    // their CNPG pod has the tenant netpol applied, but we still don't
    // want to hand them a code-exec primitive on a platform-managed
    // database — fix the blast radius with an explicit allow-list.
    const ALLOWED_EXTENSIONS = new Set<string>([
      'pgvector',
      'vector',
      'citext',
      'hstore',
      'ltree',
      'pg_trgm',
      'unaccent',
      'btree_gin',
      'btree_gist',
      'uuid-ossp',
      'pgcrypto',
      'tablefunc',
      'fuzzystrmatch',
      'pg_stat_statements',
      'postgis',
      'postgis_topology',
      'postgis_raster',
      'plpgsql',
      'intarray',
      'isn',
      'cube',
      'earthdistance',
      'timescaledb'
    ]);
    if (!ALLOWED_EXTENSIONS.has(data.name)) {
      throw new BadRequestException(
        `Extension "${data.name}" is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}`
      );
    }

    let preloadAdded = false;
    if (data.addToPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).slice();
      if (!existing.includes(data.name)) {
        existing.push(data.name);
        await this.k8sCnpg.updateCnpgParameters(
          database.namespace,
          database.clusterName,
          (database.pgParameters as Record<string, string> | null) || {},
          existing
        );
        await this.prisma.database.update({
          where: { id: database.id },
          data: { sharedPreloadLibs: existing }
        });
        preloadAdded = true;
      }
    }

    const result = await this.k8sCnpg.installCnpgExtension(
      database.namespace,
      database.clusterName,
      database.dbName,
      data.name
    );
    if (!result.success) {
      return { success: false, output: result.output, preloadAdded };
    }
    return { success: true, output: result.output, preloadAdded };
  }

  async uninstallDatabaseExtension(
    databaseId: string,
    data: { name: string; removeFromPreload?: boolean },
    clerkId: string,
    userData?: any
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Extensions require a CNPG-backed database');
    }
    if (!data.name) throw new BadRequestException('name is required');

    const result = await this.k8sCnpg.uninstallCnpgExtension(
      database.namespace,
      database.clusterName,
      database.dbName,
      data.name
    );

    if (data.removeFromPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).filter(
        (x) => x !== data.name
      );
      await this.k8sCnpg.updateCnpgParameters(
        database.namespace,
        database.clusterName,
        (database.pgParameters as Record<string, string> | null) || {},
        existing
      );
      await this.prisma.database.update({
        where: { id: database.id },
        data: { sharedPreloadLibs: existing }
      });
    }

    return { success: result.success, output: result.output };
  }

  // ── Settings ──

  async getDatabaseSettings(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(
      databaseId,
      clerkId,
      userData,
      { allowViewer: true }
    );
    if (database.mode !== 'cnpg') {
      return { parameters: {}, sharedPreloadLibraries: [] };
    }
    // Settings (pg_parameters / shared_preload_libs) are not credentials, no extra redaction needed.
    const parameters = (database.pgParameters as Record<string, string> | null) || {};
    const tuning = await this.tuningFor(database);
    const mirrored = await this.prisma.k8sObject.findFirst({
      where: { shard: 'cnpg', kind: 'Cluster', databaseId: database.id },
      select: { manifest: true }
    });
    return {
      parameters,
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || [],
      backupCompression: database.backupCompression,
      // Recomputed on read, not stored, so a value that only became dangerous
      // because the memory limit shrank still shows up without anyone re-saving.
      advisories: tuning.advisories,
      drift: parameterDrift(
        parameters,
        { max_connections: '100', shared_buffers: tuning.sharedBuffers },
        (mirrored?.manifest as any)?.spec?.postgresql?.parameters,
        Object.keys(this.PG_PARAM_BOUNDS)
      )
    };
  }

  private async tuningFor(database: {
    projectId: string;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | null;
    pgParameters: unknown;
    backupCompression: string | null;
  }) {
    const resolved = await this.quotasService.resolvePodResources(
      database.projectId,
      {
        cpuRequestMilli: database.cpuRequestMilli ?? null,
        memoryRequestBytes:
          database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null
      },
      'postgres'
    );
    return deriveDbTuning({
      memoryLimitBytes: resolved.memoryBytes,
      overrides: {
        sharedBuffers: (database.pgParameters as Record<string, string> | null)?.shared_buffers,
        backupCompression: database.backupCompression
      }
    });
  }

  async updateDatabaseSettings(
    databaseId: string,
    data: { parameters: Record<string, string>; backupCompression?: string | null },
    clerkId: string,
    userData?: any
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Settings require a CNPG-backed database');
    }

    const bounds = this.PG_PARAM_BOUNDS;
    const sanitized: Record<string, string> = {};
    for (const [key, rawVal] of Object.entries(data.parameters || {})) {
      const bound = bounds[key];
      if (!bound) continue;
      const v = String(rawVal).trim();
      if (!v) continue;
      if (bound.kind === 'int') {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < bound.min || n > bound.max) {
          throw new BadRequestException(`${key} must be between ${bound.min} and ${bound.max}`);
        }
        sanitized[key] = String(n);
      } else if (bound.kind === 'memory') {
        if (!/^\d+(kB|MB|GB)$/.test(v)) {
          throw new BadRequestException(`${key} must be a memory size like "128MB"`);
        }
        sanitized[key] = v;
      } else if (bound.kind === 'string') {
        if (bound.enum && !bound.enum.includes(v)) {
          throw new BadRequestException(`${key} must be one of: ${bound.enum.join(', ')}`);
        }
        sanitized[key] = v;
      }
    }

    let backupCompression = database.backupCompression;
    if (data.backupCompression !== undefined) {
      const c = String(data.backupCompression ?? '').trim();
      if (c && c !== 'gzip' && c !== 'none') {
        throw new BadRequestException(
          'backupCompression must be "gzip", "none", or null for automatic'
        );
      }
      backupCompression = c || null;
    }

    const resolved = await this.quotasService.resolvePodResources(
      database.projectId,
      {
        cpuRequestMilli: database.cpuRequestMilli ?? null,
        memoryRequestBytes:
          database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null
      },
      'postgres'
    );
    const tuning = deriveDbTuning({
      memoryLimitBytes: resolved.memoryBytes,
      overrides: { sharedBuffers: sanitized.shared_buffers, backupCompression }
    });

    // The k8s call below is a JSON merge patch, so dropping shared_buffers from
    // `sanitized` would leave the old value on the cluster forever. Write the
    // derived value in its place: that is what makes clearing the field a reset
    // rather than a no-op. The Prisma row still stores only what the user set,
    // so "is this overridden?" stays answerable.
    const existingPreload = (database.sharedPreloadLibs as string[] | null) || [];
    const cleared = Object.fromEntries(
      Object.keys((database.pgParameters as Record<string, string> | null) || {})
        .filter((key) => !(key in sanitized) && key !== 'shared_buffers')
        .map((key) => [key, null])
    );
    await this.k8sCnpg.updateCnpgParameters(
      database.namespace,
      database.clusterName,
      { ...cleared, ...sanitized, shared_buffers: tuning.sharedBuffers },
      existingPreload
    );
    if (backupCompression !== database.backupCompression) {
      await this.k8sCnpg
        .applyCnpgDerivedTuning(database.namespace, database.clusterName, tuning)
        .catch((e: any) => {
          console.warn(
            `[DB/tuning] Failed to apply compression on ${database.clusterName}: ${e?.message ?? e}`
          );
        });
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { pgParameters: sanitized, backupCompression }
    });

    // Advisories, never rejections: the value above was applied exactly as given.
    return {
      success: true,
      parameters: sanitized,
      backupCompression,
      advisories: tuning.advisories
    };
  }

  // ── Public (MetalLB) exposure ──

  private readonly PUBLIC_PORT_MIN = 30000;

  private readonly PUBLIC_PORT_MAX = 32767;

  private async pickFreePublicPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true }
    });
    const dbPorts = new Set(
      dbPortsRaw.map((r) => r.publicPort).filter((n): n is number => typeof n === 'number')
    );

    let livePorts = new Set<number>();
    try {
      livePorts = new Set(await this.k8sNetwork.listInUsePortsOnIp(ip));
    } catch (e: any) {
      console.error(`[DB/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    for (let i = 0; i < 200; i++) {
      const port =
        Math.floor(Math.random() * (this.PUBLIC_PORT_MAX - this.PUBLIC_PORT_MIN + 1)) +
        this.PUBLIC_PORT_MIN;
      if (dbPorts.has(port) || livePorts.has(port)) continue;
      return port;
    }
    throw new BadRequestException('Could not find a free public port after 200 attempts');
  }

  async enableDatabasePublic(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Public exposure requires a CNPG-backed database');
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: database.project.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    const ip = (org?.databasePublicIp || '').trim() || this.instanceConfig.defaultPublicIp();
    if (!ip) {
      throw new BadRequestException(
        'No public database IP is configured. Set one in organization settings, or ask an instance admin to set an instance-wide default.'
      );
    }

    if (database.publicEnabled && database.publicIp === ip && database.publicPort) {
      return {
        enabled: true,
        host: database.publicIp,
        port: database.publicPort,
        connectionString: `postgresql://${database.dbUser}:${this.crypto.open(database.dbPassword)}@${database.publicIp}:${database.publicPort}/${database.dbName}`
      };
    }

    const port =
      database.publicIp === ip && database.publicPort
        ? database.publicPort
        : await this.pickFreePublicPort(ip);

    await this.k8sNetwork.exposeCnpgClusterPublic({
      namespace: database.namespace,
      clusterName: database.clusterName,
      loadBalancerIp: ip,
      port
    });

    // Punch a hole in the namespace's default-deny-all NetworkPolicy so external
    // clients can actually reach port 5432 on the primary pod.
    try {
      await this.k8sNetwork.upsertPublicDatabaseNetworkPolicy(
        database.namespace,
        database.clusterName
      );
    } catch (e: any) {
      console.error(`[DB/public] Failed to create ingress NetworkPolicy: ${e?.message}`);
    }

    // Copy the wildcard TLS secret into the project namespace and wire it into the CNPG Cluster
    // so Postgres serves the Let's Encrypt cert instead of its self-signed default.
    const hostname = this.k8sCnpg.publicTlsHostname(database.namespace, database.clusterName);
    const legacyHostname = this.k8sCnpg.legacyPublicTlsHostname(database.clusterName);
    if (hostname) {
      try {
        await this.k8sCnpg.syncPublicTlsSecret(database.namespace);
        await this.k8sCnpg.patchCnpgClusterTls(
          database.namespace,
          database.clusterName,
          [hostname, legacyHostname].filter(Boolean)
        );
      } catch (e: any) {
        console.error(`[DB/public] Failed to configure TLS: ${e?.message}`);
      }
    }

    await this.prisma.database.update({
      where: { id: database.id },
      data: { publicEnabled: true, publicIp: ip, publicPort: port }
    });
    signalEnvironmentEnvChanged({
      projectId: database.projectId,
      environmentId: database.environmentId
    });

    return {
      enabled: true,
      host: hostname,
      ip,
      port,
      connectionString: `postgresql://${database.dbUser}:${this.crypto.open(database.dbPassword)}@${hostname}:${port}/${database.dbName}?sslmode=verify-full&sslrootcert=system`
    };
  }

  async disableDatabasePublic(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { enabled: false };
    }
    try {
      await this.k8sNetwork.unexposeCnpgCluster(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to delete public Service: ${e?.message}`);
    }
    try {
      await this.k8sCnpg.clearCnpgClusterTls(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to clear TLS on Cluster: ${e?.message}`);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { publicEnabled: false, publicIp: null, publicPort: null }
    });
    signalEnvironmentEnvChanged({
      projectId: database.projectId,
      environmentId: database.environmentId
    });
    return { enabled: false };
  }

  private readonly PG_PARAM_BOUNDS: Record<string, any> = PG_PARAM_BOUNDS;
}

function clusterMirror(db: {
  clusterStatus?: unknown;
  clusterSyncedAt?: Date | null;
  sizeBytes?: bigint | number | null;
  connections?: number | null;
  statsAt?: Date | null;
  volumeUsedBytes?: bigint | number | null;
  volumeCapacityBytes?: bigint | number | null;
  walPendingSegments?: number | null;
}): { cluster: ClusterSnapshot | null; stats: DbStats } {
  const cluster =
    db.clusterSyncedAt && db.clusterStatus && typeof db.clusterStatus === 'object'
      ? (db.clusterStatus as ClusterSnapshot)
      : null;
  return {
    cluster,
    stats: {
      sizeBytes: db.sizeBytes ?? null,
      connections: db.connections ?? null,
      statsAt: db.statsAt ?? null,
      volumeUsedBytes: db.volumeUsedBytes ?? null,
      volumeCapacityBytes: db.volumeCapacityBytes ?? null,
      walPendingSegments: db.walPendingSegments ?? null
    }
  };
}
