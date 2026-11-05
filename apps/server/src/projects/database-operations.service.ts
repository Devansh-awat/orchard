import {
  BadRequestException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma, type DatabaseOperation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { QuotasService } from '../quotas/quotas.service';
import { deriveDbTuning, walSlotKeepSize } from '../kubernetes/db-tuning';
import { containerResources, databaseSizing } from '../kubernetes/resource-spec';
import {
  backupBefore,
  backupServerName,
  clusterProgress,
  DRILL_CHECK_SQL,
  inTreeExternalCluster,
  judgeDrill,
  liveCloneBootstrap,
  liveCloneSecretNames,
  liveCloneSource,
  objectStoreBody,
  objectStoreName,
  parseDrillSnapshot,
  pluginExternalCluster,
  recoveryBootstrap,
  recoveryClusterSpec,
  type RecoveryTarget
} from '../kubernetes/cnpg-recovery';
import { WAL_ARCHIVE_MAX_PARALLEL } from '../kubernetes/cnpg-defaults';
import { normalizeBackupEndpointURL } from '../kubernetes/k8s-cnpg.service';
import { clusterSettled } from '../kubernetes/postgres-images';
import { clusterSnapshot } from '../kubernetes/cnpg-status';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import {
  defaultBackupCronFor,
  formatSlug,
  toQuartzCron,
  truncateK8sName,
  truncateKeepingSuffix
} from './projects.utils';
import type { DatabasesService } from './databases.service';
import { EnvironmentsService } from './environments.service';
import { hasBackupRoute } from '../instance-config/object-storage';

export type OperationKind = 'restore' | 'fork' | 'undelete' | 'drill' | 'upgrade';

export type OperationTarget =
  | { type: 'latest' }
  | { type: 'now' }
  | { type: 'time'; time: string }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'backup'; backupId: string }
  | { type: 'major'; major: number; image: string };

export interface OperationSource {
  databaseId: string | null;
  trashId: string | null;
  organizationId: string;
  projectId: string;
  environmentId: string | null;
  name: string;
  namespace: string;
  clusterName: string;
  serverName: string;
  pgMajor: number;
  storageSize: string;
  replicas: number;
  cpuRequestMilli: number | null;
  memoryRequestBytes: number | null;
  pgParameters: Record<string, string> | null;
  sharedPreloadLibs: string[] | null;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  nodePoolId: string | null;
  placementOverride: unknown;
}

const ACTIVE = ['pending', 'running'];
const RECOVERY_DEADLINE_MS = 3 * 60 * 60 * 1000;
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
const RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 30;

export const DRILL_NAMESPACE = () => process.env.DB_DRILL_NAMESPACE || 'orchard-restore-drills';

export function planRejected(phase: string, e: unknown): boolean {
  if (phase !== 'queued') return false;
  if ((e as { code?: string })?.code === 'P2002') return true;
  if (!(e instanceof HttpException)) return false;
  const status = e.getStatus();
  return status >= 400 && status < 500;
}

function sourcePrefix(src: Pick<OperationSource, 'namespace' | 'clusterName'>): string {
  return `${src.namespace}/${src.clusterName}/`;
}

@Injectable()
export class DatabaseOperationsService {
  private readonly logger = new Logger(DatabaseOperationsService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly k8sNamespace: K8sNamespaceService,
    private readonly leader: LeaderElectionService,
    private readonly crypto: SecretCryptoService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotas: QuotasService,
    private readonly environments: EnvironmentsService,
    private readonly moduleRef: ModuleRef
  ) {}

  private async databases(): Promise<DatabasesService> {
    const { DatabasesService: Svc } = await import('./databases.service.js');
    return this.moduleRef.get(Svc, { strict: false });
  }

  async sourceFromDatabase(databaseId: string): Promise<OperationSource> {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: { select: { organizationId: true } } }
    });
    if (!db) throw new NotFoundException('Database not found');
    if (db.mode !== 'cnpg' || !db.namespace || !db.clusterName) {
      throw new BadRequestException('Only dedicated databases can be restored or forked');
    }
    return {
      databaseId: db.id,
      trashId: null,
      organizationId: db.project.organizationId,
      projectId: db.projectId,
      environmentId: db.environmentId,
      name: db.name,
      namespace: db.namespace,
      clusterName: db.clusterName,
      serverName: db.backupServerName || db.clusterName,
      pgMajor: db.pgMajor ?? 17,
      storageSize: db.storageSize || '1Gi',
      replicas: db.replicas ?? 1,
      cpuRequestMilli: db.cpuRequestMilli ?? null,
      memoryRequestBytes: db.memoryRequestBytes != null ? Number(db.memoryRequestBytes) : null,
      pgParameters: (db.pgParameters as Record<string, string> | null) ?? null,
      sharedPreloadLibs: (db.sharedPreloadLibs as string[] | null) ?? null,
      dbName: db.dbName,
      dbUser: db.dbUser,
      dbPassword: db.dbPassword,
      nodePoolId: db.nodePoolId ?? null,
      placementOverride: db.placementOverride ?? null
    };
  }

  async enqueue(input: {
    kind: OperationKind;
    mode?: 'in_place' | 'fork' | null;
    databaseId: string | null;
    source: OperationSource;
    target: OperationTarget;
    request?: Record<string, unknown>;
    requestedBy?: string | null;
  }): Promise<DatabaseOperation> {
    if (input.databaseId) {
      const busy = await this.prisma.databaseOperation.findFirst({
        where: {
          databaseId: input.databaseId,
          status: { in: ACTIVE },
          kind: { in: ['restore', 'undelete', 'upgrade'] }
        },
        select: { id: true }
      });
      if (busy && ['restore', 'undelete', 'upgrade'].includes(input.kind)) {
        throw new BadRequestException('A restore or upgrade is already running for this database');
      }
    }
    return this.prisma.databaseOperation.create({
      data: {
        kind: input.kind,
        mode: input.mode ?? null,
        databaseId: input.databaseId,
        source: input.source as unknown as Prisma.InputJsonValue,
        target: input.target as unknown as Prisma.InputJsonValue,
        request: (input.request ?? {}) as Prisma.InputJsonValue,
        requestedBy: input.requestedBy ?? null
      }
    });
  }

  get(id: string) {
    return this.prisma.databaseOperation.findUnique({ where: { id } });
  }

  list(databaseId: string, kinds?: OperationKind[], take = 50) {
    return this.prisma.databaseOperation.findMany({
      where: {
        OR: [{ databaseId }, { targetDatabaseId: databaseId }],
        ...(kinds ? { kind: { in: kinds } } : {})
      },
      orderBy: { createdAt: 'desc' },
      take
    });
  }

  @Interval(10_000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      const ops = await this.prisma.databaseOperation.findMany({
        where: { status: { in: ACTIVE } },
        orderBy: { createdAt: 'asc' },
        take: 20
      });
      for (const op of ops) {
        await this.advance(op).catch(async (e) => {
          const attempts = op.attempts + 1;
          const message = k8sErrorMessage(e);
          this.logger.warn(`operation ${op.id} (${op.kind}/${op.phase}) failed a step: ${message}`);
          if (attempts >= MAX_ATTEMPTS || planRejected(op.phase, e)) {
            await this.fail(op, message);
          } else {
            await this.prisma.databaseOperation.update({
              where: { id: op.id },
              data: { attempts, error: message }
            });
          }
        });
      }
      await this.retireOldClusters();
    } catch (e: any) {
      this.logger.warn(`operations tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async setPhase(
    op: DatabaseOperation,
    phase: string,
    data: Prisma.DatabaseOperationUpdateInput = {}
  ) {
    return this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: { phase, status: 'running', attempts: 0, error: null, ...data }
    });
  }

  private async advance(op: DatabaseOperation): Promise<void> {
    if (op.deadlineAt && op.deadlineAt.getTime() < Date.now()) {
      if (op.phase === 'recovering') {
        await this.fail(op, "Recovery didn't finish in time");
        return;
      }
      if (op.phase.startsWith('rehearsal_')) {
        await this.fail(op, "The rehearsal upgrade didn't finish in time; nothing was changed");
        return;
      }
      if (op.phase === 'upgrade_waiting') {
        await this.revertUpgrade(op, "The upgrade didn't finish in time");
        return;
      }
    }
    switch (op.phase) {
      case 'queued':
        await this.plan(op);
        return;
      case 'provisioning':
        await this.provision(op);
        return;
      case 'recovering':
        await this.watchRecovery(op);
        return;
      case 'verifying':
        await this.verify(op);
        return;
      case 'cutting_over':
        await this.cutOver(op);
        return;
      case 'finalizing':
        await this.finalize(op);
        return;
      case 'cleaning_up':
        await this.cleanUp(op);
        return;
      case 'rehearsal_provisioning':
        await this.rehearsalProvision(op);
        return;
      case 'rehearsal_cloning':
        await this.rehearsalCloned(op);
        return;
      case 'rehearsal_upgrading':
        await this.rehearsalUpgraded(op);
        return;
      case 'upgrading':
        await this.startUpgrade(op);
        return;
      case 'upgrade_waiting':
        await this.watchUpgrade(op);
        return;
      case 'upgrade_finishing':
        await this.finishUpgrade(op);
        return;
      default:
        await this.fail(op, `Unknown phase ${op.phase}`);
    }
  }

  private async plan(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const req = (op.request ?? {}) as Record<string, any>;
    const suffix = Date.now().toString(36);

    if (op.kind === 'upgrade') {
      const rehearse = (op.request as any)?.rehearse !== false;
      await this.setPhase(op, rehearse ? 'rehearsal_provisioning' : 'upgrading', {
        startedAt: new Date(),
        targetNamespace: src.namespace,
        targetClusterName: rehearse
          ? truncateKeepingSuffix(src.clusterName, `-up${suffix.slice(-5)}`, 53)
          : src.clusterName,
        targetDatabaseId: src.databaseId,
        deadlineAt: new Date(Date.now() + RECOVERY_DEADLINE_MS)
      });
      return;
    }

    if (op.kind === 'drill') {
      await this.k8sNamespace.createNamespace(DRILL_NAMESPACE()).catch((e: any) => {
        if (!/already exists|409/i.test(String(e?.message ?? e))) throw e;
      });
      await this.setPhase(op, 'provisioning', {
        startedAt: new Date(),
        targetNamespace: DRILL_NAMESPACE(),
        targetClusterName: truncateK8sName(`drill-${op.id.slice(0, 8)}-${suffix}`, 53)
      });
      return;
    }

    if (op.kind === 'restore' && op.mode !== 'fork') {
      await this.prisma.database.update({
        where: { id: src.databaseId! },
        data: { status: 'restoring' }
      });
      await this.setPhase(op, 'provisioning', {
        startedAt: new Date(),
        targetNamespace: src.namespace,
        targetClusterName: truncateKeepingSuffix(
          src.clusterName.replace(/-r[0-9a-z]{6,}$/, ''),
          `-r${suffix}`,
          53
        ),
        targetDatabaseId: src.databaseId
      });
      return;
    }

    const dbs = await this.databases();
    const project = await this.prisma.project.findUnique({
      where: { id: req.projectId ?? src.projectId },
      include: { organization: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    let environmentId: string | null = req.environmentId ?? src.environmentId ?? null;
    if (environmentId) {
      const exists = await this.prisma.environment.findUnique({ where: { id: environmentId } });
      if (!exists || exists.projectId !== project.id) environmentId = null;
    }
    const env = await this.environments.resolveEnvironment(project.id, environmentId);
    const name = String(
      req.name || (op.kind === 'undelete' ? src.name : `${src.name}-fork`)
    ).trim();
    const clash = await this.prisma.database.findFirst({
      where: { projectId: project.id, environmentId: env?.id ?? null, name }
    });
    if (clash)
      throw new BadRequestException(`A database named ${name} already exists in that environment`);
    const namespace = env?.namespace ?? project.namespace;
    const sized = await this.quotas.resolvePodResources(
      project.id,
      { cpuRequestMilli: src.cpuRequestMilli, memoryRequestBytes: src.memoryRequestBytes },
      'postgres'
    );
    const total = {
      cpuMilli: sized.cpuMilli * Math.max(1, src.replicas),
      memoryBytes: sized.memoryBytes * Math.max(1, src.replicas)
    };
    await this.quotas.enforceOrgCapForNewPod(project.organizationId, total);
    await this.quotas.enforceProjectCapForNewPod(project.id, {
      ...total,
      pods: Math.max(1, src.replicas)
    });
    await this.quotas.enforceMemberAllowanceForNewPod(
      project.organizationId,
      project.ownerId,
      total
    );
    const id = op.kind === 'undelete' && src.trashId ? src.trashId : randomUUID();
    const clusterName = truncateK8sName(
      `pg-${formatSlug(name).slice(0, 40)}-${suffix.slice(-4)}`,
      53
    );
    const keepsCredentials = op.kind === 'undelete';
    const password = keepsCredentials ? this.crypto.open(src.dbPassword) : dbs.generatePassword();
    const forked = op.kind === 'fork' || op.mode === 'fork';
    const row: Prisma.DatabaseUncheckedCreateInput = {
      id,
      projectId: project.id,
      environmentId: env?.id ?? null,
      name,
      dbName: src.dbName,
      dbUser: keepsCredentials ? src.dbUser : src.dbUser,
      dbPassword: this.crypto.seal(password),
      status: 'restoring',
      mode: 'cnpg',
      pgMajor: src.pgMajor,
      namespace,
      clusterName,
      storageSize: src.storageSize,
      replicas: src.replicas,
      cpuRequestMilli: src.cpuRequestMilli,
      memoryRequestBytes: src.memoryRequestBytes != null ? BigInt(src.memoryRequestBytes) : null,
      pgParameters: (src.pgParameters ?? undefined) as Prisma.InputJsonValue | undefined,
      sharedPreloadLibs: (src.sharedPreloadLibs ?? undefined) as Prisma.InputJsonValue | undefined,
      nodePoolId: src.nodePoolId,
      placementOverride: (src.placementOverride ?? undefined) as Prisma.InputJsonValue | undefined,
      host: `${clusterName}-rw.${namespace}.svc.cluster.local`,
      port: 5432,
      backupServerName: backupServerName(clusterName, id),
      forkedFromId: forked ? src.databaseId : null,
      forkedAt: forked ? new Date() : null,
      createdBy: op.requestedBy
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.database.create({ data: row });
      await tx.databaseOperation.update({
        where: { id: op.id },
        data: {
          phase: 'provisioning',
          status: 'running',
          attempts: 0,
          error: null,
          startedAt: new Date(),
          targetNamespace: namespace,
          targetClusterName: clusterName,
          targetDatabaseId: id
        }
      });
    });
  }

  private async resolveTarget(
    op: DatabaseOperation,
    src: OperationSource
  ): Promise<RecoveryTarget | 'live'> {
    const target = op.target as unknown as OperationTarget;
    switch (target.type) {
      case 'latest':
        return { type: 'latest' };
      case 'now': {
        if (!src.databaseId) return { type: 'latest' };
        const live = await this.k8sCnpg.readCluster(src.namespace, src.clusterName);
        return live && clusterProgress(live).state === 'ready' ? 'live' : { type: 'latest' };
      }
      case 'time':
        return { type: 'time', time: target.time };
      case 'backup': {
        const backup = await this.prisma.databaseBackup.findUnique({
          where: { id: target.backupId }
        });
        if (!backup?.barmanId) throw new BadRequestException("You can't restore that backup by ID");
        return { type: 'backup', backupId: backup.barmanId };
      }
      case 'checkpoint': {
        const cp = await this.prisma.databaseCheckpoint.findUnique({
          where: { id: target.checkpointId }
        });
        if (!cp || cp.status !== 'durable' || !cp.lsn) {
          throw new BadRequestException("You can't restore that checkpoint yet");
        }
        const backups = await this.prisma.databaseBackup.findMany({
          where: { databaseId: cp.databaseId, status: 'completed' },
          select: { barmanId: true, status: true, endLsn: true, completedAt: true }
        });
        const backupId = backupBefore(backups, cp.lsn);
        if (!backupId) throw new BadRequestException('No backup was taken before that checkpoint');
        return { type: 'restore_point', name: cp.restorePointName, backupId };
      }
    }
  }

  private async provision(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const ns = op.targetNamespace!;
    const name = op.targetClusterName!;
    const dbs = await this.databases();
    const org = await this.prisma.organization.findUnique({
      where: { id: src.organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });

    const target = await this.resolveTarget(op, src);
    const isDrill = op.kind === 'drill';
    const writePrefix = isDrill ? `_drills/${op.id}/` : `${ns}/${name}/`;

    let accessKey = op.storageAccessKey;
    let r2: { endpoint: string; bucket: string; accessKey: string; secretKey: string } | null =
      null;
    if (accessKey) {
      const row = await this.prisma.storageAccessKey.findUnique({ where: { accessKey } });
      const route = dbs.describeBackupRoute(org);
      if (row && route) {
        r2 = {
          endpoint: route.endpoint,
          bucket: route.bucket,
          accessKey: row.accessKey,
          secretKey: row.secret
        };
      }
    }
    if (!r2) {
      const minted = await dbs.mintScopedR2(org, {
        organizationId: src.organizationId,
        writePrefix,
        readPrefixes: [sourcePrefix(src)],
        purpose: `database-${op.kind}`,
        operationId: op.id,
        ttlMs: KEY_TTL_MS
      });
      if (!minted && target !== 'live') {
        throw new BadRequestException('No backup storage is configured for this organization');
      }
      if (minted) {
        r2 = minted.r2;
        accessKey = minted.scopedKey;
        if (accessKey) {
          await this.prisma.databaseOperation.update({
            where: { id: op.id },
            data: { storageAccessKey: accessKey }
          });
        }
      }
    }

    const targetDb = op.targetDatabaseId
      ? await this.prisma.database.findUnique({ where: { id: op.targetDatabaseId } })
      : null;
    const owner = {
      database: targetDb?.dbName ?? src.dbName,
      owner: targetDb?.dbUser ?? src.dbUser,
      secretName: `${name}-app`
    };
    const password = targetDb
      ? this.crypto.open(targetDb.dbPassword)
      : this.crypto.open(src.dbPassword);
    await this.k8sCnpg.writeSecret(
      ns,
      owner.secretName,
      { username: owner.owner, password },
      'kubernetes.io/basic-auth'
    );

    const r2Secret = `${name}-r2`;
    if (r2) {
      await this.k8sCnpg.writeSecret(ns, r2Secret, {
        ACCESS_KEY_ID: r2.accessKey,
        ACCESS_SECRET_KEY: r2.secretKey
      });
    }

    const usePlugin = await this.k8sCnpg.usePluginForNewClusters();
    const endpointURL = r2 ? normalizeBackupEndpointURL(r2.endpoint) : '';
    let bootstrap: unknown;
    let externalClusters: unknown[];
    if (target === 'live') {
      const secrets = liveCloneSecretNames(name);
      await this.k8sCnpg.copySecret(
        src.namespace,
        `${src.clusterName}-replication`,
        ns,
        secrets.replication
      );
      await this.k8sCnpg.copySecret(src.namespace, `${src.clusterName}-ca`, ns, secrets.ca);
      bootstrap = liveCloneBootstrap(owner);
      externalClusters = [liveCloneSource(`${src.clusterName}-rw.${src.namespace}.svc`, name)];
    } else {
      const sourceBucket = await dbs.sourceBackupBucket(org, src, r2!.bucket);
      const location = {
        destinationPath: `s3://${sourceBucket}/${src.namespace}/${src.clusterName}`,
        endpointURL,
        secretName: r2Secret,
        serverName: src.serverName
      };
      if (usePlugin) {
        const originStore = `${name}-origin`.slice(0, 63);
        await this.k8sCnpg.upsertObjectStore(
          ns,
          objectStoreBody(ns, originStore, location, {
            walMaxParallel: WAL_ARCHIVE_MAX_PARALLEL,
            dataCompression: null
          })
        );
        externalClusters = [pluginExternalCluster(originStore, src.serverName)];
      } else {
        externalClusters = [inTreeExternalCluster(location, WAL_ARCHIVE_MAX_PARALLEL)];
      }
      bootstrap = recoveryBootstrap(target, owner);
    }

    const resources = await this.quotas
      .podSizing(
        targetDb?.projectId ?? src.projectId,
        { cpuRequestMilli: src.cpuRequestMilli, memoryRequestBytes: src.memoryRequestBytes },
        'postgres'
      )
      .catch(() => null);
    const tuning = deriveDbTuning({
      memoryLimitBytes: resources?.memoryBytes,
      overrides: { sharedBuffers: src.pgParameters?.shared_buffers }
    });
    const parameters: Record<string, string> = {
      max_connections: '100',
      shared_buffers: tuning.sharedBuffers,
      max_slot_wal_keep_size: walSlotKeepSize(src.storageSize),
      ...(src.pgParameters ?? {})
    };

    let archive: Parameters<typeof recoveryClusterSpec>[0]['archive'] = null;
    if (!isDrill && r2) {
      const inPlace = op.kind === 'restore' && op.mode !== 'fork';
      const serverName = inPlace ? name : targetDb?.backupServerName || name;
      if (usePlugin) {
        const store = objectStoreName(name);
        await this.k8sCnpg.upsertObjectStore(
          ns,
          objectStoreBody(
            ns,
            store,
            {
              destinationPath: `s3://${r2.bucket}/${ns}/${name}`,
              endpointURL,
              secretName: r2Secret
            },
            { walMaxParallel: WAL_ARCHIVE_MAX_PARALLEL, dataCompression: 'gzip' }
          )
        );
        archive = { kind: 'plugin', objectStore: store, serverName };
      } else {
        archive = {
          kind: 'barman',
          backup: {
            retentionPolicy: '30d',
            barmanObjectStore: {
              destinationPath: `s3://${r2.bucket}/${ns}/${name}`,
              endpointURL,
              ...(serverName !== name ? { serverName } : {}),
              s3Credentials: {
                accessKeyId: { name: r2Secret, key: 'ACCESS_KEY_ID' },
                secretAccessKey: { name: r2Secret, key: 'ACCESS_SECRET_KEY' }
              },
              wal: { compression: 'gzip', maxParallel: WAL_ARCHIVE_MAX_PARALLEL },
              ...(tuning.dataCompression ? { data: { compression: tuning.dataCompression } } : {})
            }
          }
        };
      }
    }

    const sourceCluster = src.databaseId
      ? await this.k8sCnpg.readCluster(src.namespace, src.clusterName).catch(() => null)
      : null;
    const spec = recoveryClusterSpec({
      instances: isDrill ? 1 : src.replicas,
      imageName: dbs.postgresImageFor(src.pgMajor),
      storageSize: src.storageSize,
      storageClass: process.env.K8S_STORAGE_CLASS || undefined,
      resources: resources
        ? containerResources(databaseSizing(resources, parameters.shared_buffers))
        : undefined,
      parameters,
      sharedPreloadLibraries: src.sharedPreloadLibs ?? undefined,
      affinity: isDrill ? undefined : sourceCluster?.spec?.affinity,
      primaryUpdateStrategy: sourceCluster?.spec?.primaryUpdateStrategy,
      bootstrap,
      externalClusters,
      archive
    });

    try {
      await this.k8sCnpg.createClusterFromSpec(ns, name, spec, {
        'orchard.my/operation': op.id,
        ...(src.databaseId ? { 'orchard/restore-source': src.clusterName } : {})
      });
    } catch (e: any) {
      if (e?.response?.statusCode !== 409) throw e;
    }
    await this.setPhase(op, 'recovering', {
      deadlineAt: new Date(Date.now() + RECOVERY_DEADLINE_MS),
      result: { recoveredFrom: target === 'live' ? 'live' : target } as Prisma.InputJsonValue
    });
  }

  private async watchRecovery(op: DatabaseOperation) {
    const cluster = await this.k8sCnpg.readCluster(op.targetNamespace!, op.targetClusterName!);
    const progress = clusterProgress(cluster);
    if (progress.state === 'failed') {
      await this.fail(op, progress.message || 'Recovery failed');
      return;
    }
    if (progress.state !== 'ready') {
      const failure = await this.k8sCnpg
        .recoveryJobFailure(op.targetNamespace!, op.targetClusterName!)
        .catch((e: any) => {
          this.logger.warn(`recovery jobs of ${op.id} unreadable: ${k8sErrorMessage(e)}`);
          return null;
        });
      if (failure) {
        await this.fail(op, failure);
        return;
      }
      if (progress.message) {
        await this.prisma.databaseOperation.update({
          where: { id: op.id },
          data: { error: null, result: { ...(op.result as object), progress: progress.message } }
        });
      }
      return;
    }
    const next =
      op.kind === 'drill'
        ? 'verifying'
        : op.kind === 'restore' && op.mode !== 'fork'
          ? 'cutting_over'
          : 'finalizing';
    await this.setPhase(op, next, {
      result: { ...(op.result as object), recoveredAt: new Date().toISOString() }
    });
  }

  private async verify(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const restoredOut = await this.k8sCnpg.runPsqlInCnpg(
      op.targetNamespace!,
      op.targetClusterName!,
      src.dbName,
      DRILL_CHECK_SQL,
      { tuplesOnly: true, catalogOnly: true }
    );
    const restored = restoredOut.success ? parseDrillSnapshot(restoredOut.stdout) : null;
    const sourceOut = await this.k8sCnpg
      .runPsqlInCnpg(src.namespace, src.clusterName, src.dbName, DRILL_CHECK_SQL, {
        tuplesOnly: true,
        catalogOnly: true
      })
      .catch(() => null);
    const source = sourceOut?.success ? parseDrillSnapshot(sourceOut.stdout) : null;
    const verdict = judgeDrill(source, restored);
    const started = op.startedAt?.getTime() ?? op.createdAt.getTime();
    const recoveredAt = Date.parse(String((op.result as any)?.recoveredAt ?? '')) || Date.now();
    await this.setPhase(op, 'cleaning_up', {
      result: {
        ...(op.result as object),
        verdict,
        sizeBytes: restored?.sizeBytes ?? null,
        sourceSizeBytes: source?.sizeBytes ?? null,
        recoveryMs: recoveredAt - started
      } as unknown as Prisma.InputJsonValue
    });
  }

  private async cleanUp(op: DatabaseOperation) {
    await this.removeTarget(op);
    const verdict = (op.result as any)?.verdict;
    const passed = op.kind !== 'drill' || verdict?.passed === true;
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        phase: 'done',
        status: passed ? 'succeeded' : 'failed',
        error: passed ? null : (verdict?.reasons ?? []).join('; ') || 'Restore check failed',
        finishedAt: new Date()
      }
    });
  }

  private async cutOver(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const ns = op.targetNamespace!;
    const name = op.targetClusterName!;
    const db = await this.prisma.database.findUnique({ where: { id: src.databaseId! } });
    if (!db) {
      await this.fail(op, 'The database was deleted during the restore');
      return;
    }
    const key = op.storageAccessKey
      ? await this.prisma.storageAccessKey.findUnique({ where: { accessKey: op.storageAccessKey } })
      : null;
    const oldCluster = db.clusterName!;
    const usesPlugin = await this.k8sCnpg.usePluginForNewClusters();
    await this.prisma.database.update({
      where: { id: db.id },
      data: {
        clusterName: name,
        host: `${name}-rw.${ns}.svc.cluster.local`,
        port: 5432,
        status: 'ready',
        ddlGuardVersion: null,
        ...(await this.clusterMirrorFields(ns, name)),
        backupServerName: name,
        backupMethod: usesPlugin ? 'plugin' : 'barman',
        ...(key ? { r2ProxyAccessKey: key.accessKey, r2ProxySecret: key.secret } : {}),
        r2RestoreAccessKey: null,
        r2RestoreSecret: null,
        r2RestoreClusterName: null
      }
    });
    if (key)
      await this.prisma.storageAccessKey
        .delete({ where: { accessKey: key.accessKey } })
        .catch(() => {});
    const dbs = await this.databases();
    await dbs.followCredentialChange(db.id, 'restore').catch((e: any) => {
      this.logger.warn(
        `credential follow-up after restore of ${db.name} failed: ${e?.message ?? e}`
      );
    });
    await this.moveSchedule(db, ns, oldCluster, name);
    await dbs.movePublicExposure(db.id, oldCluster).catch((e: any) => {
      this.logger.warn(
        `public access didn't follow the restore of ${db.name}: ${k8sErrorMessage(e)}`
      );
    });
    await this.k8sCnpg
      .patchCluster(ns, oldCluster, { metadata: { annotations: { 'cnpg.io/hibernation': 'on' } } })
      .catch((e: any) =>
        this.logger.warn(`couldn't stop old cluster ${oldCluster}: ${k8sErrorMessage(e)}`)
      );
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        phase: 'done',
        status: 'succeeded',
        finishedAt: new Date(),
        result: {
          ...(op.result as object),
          retired: {
            namespace: ns,
            clusterName: oldCluster,
            retireAfter: new Date(Date.now() + RETIRE_AFTER_MS).toISOString()
          }
        } as Prisma.InputJsonValue
      }
    });
  }

  private async clusterMirrorFields(ns: string, name: string) {
    const live = await this.k8sCnpg.readCluster(ns, name).catch(() => null);
    return live
      ? { clusterStatus: clusterSnapshot(live) as object, clusterSyncedAt: new Date() }
      : { clusterStatus: Prisma.DbNull, clusterSyncedAt: null };
  }

  private async finalize(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const ns = op.targetNamespace!;
    const name = op.targetClusterName!;
    const key = op.storageAccessKey
      ? await this.prisma.storageAccessKey.findUnique({ where: { accessKey: op.storageAccessKey } })
      : null;
    const db = await this.prisma.database.update({
      where: { id: op.targetDatabaseId! },
      data: {
        status: 'ready',
        backupMethod: (await this.k8sCnpg.usePluginForNewClusters()) ? 'plugin' : 'barman',
        ...(key ? { r2ProxyAccessKey: key.accessKey, r2ProxySecret: key.secret } : {})
      }
    });
    if (key)
      await this.prisma.storageAccessKey
        .delete({ where: { accessKey: key.accessKey } })
        .catch(() => {});
    await this.moveSchedule(db, ns, null, name);
    if (op.kind === 'undelete' && src.trashId) {
      await this.prisma.deletedDatabase
        .update({ where: { id: src.trashId }, data: { restoredAs: db.id } })
        .catch(() => {});
    }
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: { phase: 'done', status: 'succeeded', finishedAt: new Date() }
    });
  }

  private upgradeTarget(op: DatabaseOperation): { major: number; image: string } {
    const t = op.target as unknown as OperationTarget;
    if (t.type !== 'major') throw new BadRequestException('Not an upgrade');
    return { major: t.major, image: t.image };
  }

  private async rehearsalProvision(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const ns = op.targetNamespace!;
    const name = op.targetClusterName!;
    const dbs = await this.databases();
    const sourceCluster = await this.k8sCnpg.readCluster(src.namespace, src.clusterName);
    if (!sourceCluster) throw new NotFoundException('The database no longer exists');
    const secrets = liveCloneSecretNames(name);
    await this.k8sCnpg.copySecret(
      src.namespace,
      `${src.clusterName}-replication`,
      ns,
      secrets.replication
    );
    await this.k8sCnpg.copySecret(src.namespace, `${src.clusterName}-ca`, ns, secrets.ca);
    const owner = { database: src.dbName, owner: src.dbUser, secretName: `${name}-app` };
    await this.k8sCnpg.writeSecret(
      ns,
      owner.secretName,
      { username: src.dbUser, password: dbs.generatePassword() },
      'kubernetes.io/basic-auth'
    );
    const spec = recoveryClusterSpec({
      instances: 1,
      imageName: sourceCluster.spec?.imageName || dbs.postgresImageFor(src.pgMajor),
      storageSize: sourceCluster.spec?.storage?.size || src.storageSize,
      storageClass:
        sourceCluster.spec?.storage?.storageClass || process.env.K8S_STORAGE_CLASS || undefined,
      resources: (await this.quotas.limitsOff())
        ? { requests: sourceCluster.spec?.resources?.requests ?? {} }
        : sourceCluster.spec?.resources,
      parameters: { ...(sourceCluster.spec?.postgresql?.parameters ?? {}) },
      sharedPreloadLibraries: sourceCluster.spec?.postgresql?.shared_preload_libraries,
      bootstrap: liveCloneBootstrap(owner),
      externalClusters: [liveCloneSource(`${src.clusterName}-rw.${src.namespace}.svc`, name)],
      archive: null
    });
    try {
      await this.k8sCnpg.createClusterFromSpec(ns, name, spec, { 'orchard.my/operation': op.id });
    } catch (e: any) {
      if (e?.response?.statusCode !== 409) throw e;
    }
    await this.setPhase(op, 'rehearsal_cloning');
  }

  private async rehearsalCloned(op: DatabaseOperation) {
    const cluster = await this.k8sCnpg.readCluster(op.targetNamespace!, op.targetClusterName!);
    const progress = clusterProgress(cluster);
    if (progress.state === 'failed') {
      await this.fail(
        op,
        `Couldn't copy the database for the rehearsal: ${progress.message ?? 'unknown error'}`
      );
      return;
    }
    if (progress.state !== 'ready') return;
    const { image } = this.upgradeTarget(op);
    await this.k8sCnpg.patchCluster(op.targetNamespace!, op.targetClusterName!, {
      spec: { imageName: image }
    });
    await this.setPhase(op, 'rehearsal_upgrading', {
      result: {
        ...(op.result as object),
        rehearsalStartedAt: new Date().toISOString()
      } as Prisma.InputJsonValue
    });
  }

  private async serverMajor(ns: string, cluster: string): Promise<number | null> {
    const out = await this.k8sCnpg.runPsqlInCnpg(
      ns,
      cluster,
      'postgres',
      'SHOW server_version_num;',
      {
        tuplesOnly: true
      }
    );
    if (!out.success) return null;
    const n = Number.parseInt(out.stdout.trim(), 10);
    return Number.isInteger(n) ? Math.floor(n / 10000) : null;
  }

  private async rehearsalUpgraded(op: DatabaseOperation) {
    const { major, image } = this.upgradeTarget(op);
    const cluster = await this.k8sCnpg.readCluster(op.targetNamespace!, op.targetClusterName!);
    const progress = clusterProgress(cluster);
    if (progress.state === 'failed') {
      await this.fail(
        op,
        `The rehearsal upgrade failed, so the database was left alone: ${progress.message ?? 'unknown error'}`
      );
      return;
    }
    if (!clusterSettled(cluster, image)) return;
    const running = await this.serverMajor(op.targetNamespace!, op.targetClusterName!);
    if (running !== major) return;
    const started = Date.parse(String((op.result as any)?.rehearsalStartedAt ?? '')) || Date.now();
    await this.removeTarget({ ...op, storageAccessKey: null });
    const src = op.source as unknown as OperationSource;
    await this.setPhase(op, 'upgrading', {
      targetClusterName: src.clusterName,
      result: {
        ...(op.result as object),
        rehearsal: { passed: true, upgradeMs: Date.now() - started }
      } as Prisma.InputJsonValue
    });
  }

  private async startUpgrade(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const { major, image } = this.upgradeTarget(op);
    const db = await this.prisma.database.findUnique({ where: { id: src.databaseId! } });
    if (!db?.namespace || !db.clusterName) {
      await this.fail(op, 'The database is gone');
      return;
    }
    const cluster = await this.k8sCnpg.readCluster(db.namespace, db.clusterName);
    if (!cluster) throw new NotFoundException('The database no longer exists');
    const checkpoints = this.moduleRef.get(
      (await import('./database-checkpoints.service.js')).DatabaseCheckpointsService,
      { strict: false }
    );
    await checkpoints
      ?.before(db.id, `upgrading to Postgres ${major}`, op.requestedBy)
      .catch(() => null);
    const previousServer = currentServerName(cluster) ?? db.backupServerName ?? db.clusterName;
    const nextServer = upgradedServerName(previousServer, major);
    await this.prisma.database.update({ where: { id: db.id }, data: { status: 'upgrading' } });
    await this.k8sCnpg.patchCluster(db.namespace, db.clusterName, {
      spec: { imageName: image, ...serverNamePatch(cluster, nextServer) }
    });
    await this.setPhase(op, 'upgrade_waiting', {
      deadlineAt: new Date(Date.now() + RECOVERY_DEADLINE_MS),
      result: {
        ...(op.result as object),
        previous: {
          image: cluster.spec?.imageName ?? null,
          serverName: previousServer,
          major: src.pgMajor
        },
        nextServerName: nextServer,
        upgradeStartedAt: new Date().toISOString()
      } as Prisma.InputJsonValue
    });
  }

  private async watchUpgrade(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const { major, image } = this.upgradeTarget(op);
    const cluster = await this.k8sCnpg.readCluster(src.namespace, src.clusterName);
    const progress = clusterProgress(cluster);
    if (progress.state === 'failed') {
      await this.revertUpgrade(op, progress.message ?? "Couldn't upgrade the database");
      return;
    }
    if (!clusterSettled(cluster, image)) return;
    const running = await this.serverMajor(src.namespace, src.clusterName);
    if (running !== major) return;
    await this.setPhase(op, 'upgrade_finishing');
  }

  private async finishUpgrade(op: DatabaseOperation) {
    const src = op.source as unknown as OperationSource;
    const { major } = this.upgradeTarget(op);
    const result = (op.result ?? {}) as Record<string, any>;
    await this.prisma.database.update({
      where: { id: src.databaseId! },
      data: { pgMajor: major, backupServerName: result.nextServerName, status: 'ready' }
    });
    const org = await this.prisma.organization.findUnique({
      where: { id: src.organizationId },
      select: {
        backupR2Endpoint: true,
        backupR2Bucket: true,
        backupR2AccessKey: true,
        backupR2SecretKey: true
      }
    });
    if (hasBackupRoute(org)) {
      await this.k8sCnpg
        .createCnpgBackup(
          src.namespace,
          src.clusterName,
          `${src.clusterName}-pg${major}-${Date.now().toString(36)}`.slice(0, 63)
        )
        .catch((e: any) =>
          this.logger.warn(
            `first backup after upgrading ${src.clusterName} failed: ${k8sErrorMessage(e)}`
          )
        );
    }
    await this.k8sCnpg
      .runPsqlInCnpg(src.namespace, src.clusterName, src.dbName, 'ANALYZE;')
      .catch(() => null);
    const started = Date.parse(String(result.upgradeStartedAt ?? '')) || Date.now();
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        phase: 'done',
        status: 'succeeded',
        finishedAt: new Date(),
        result: { ...result, upgradeMs: Date.now() - started } as Prisma.InputJsonValue
      }
    });
  }

  private async revertUpgrade(op: DatabaseOperation, reason: string) {
    const src = op.source as unknown as OperationSource;
    const previous = (op.result as any)?.previous;
    const cluster = await this.k8sCnpg
      .readCluster(src.namespace, src.clusterName)
      .catch(() => null);
    if (previous?.image && cluster) {
      await this.k8sCnpg
        .patchCluster(src.namespace, src.clusterName, {
          spec: { imageName: previous.image, ...serverNamePatch(cluster, previous.serverName) }
        })
        .catch((e: any) =>
          this.logger.warn(`reverting ${src.clusterName} failed: ${k8sErrorMessage(e)}`)
        );
    }
    await this.prisma.database
      .updateMany({
        where: { id: src.databaseId!, status: 'upgrading' },
        data: { status: 'ready' }
      })
      .catch(() => {});
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        status: 'failed',
        phase: 'done',
        error:
          `${reason}. The database was put back on Postgres ${previous?.major ?? src.pgMajor}.`.slice(
            0,
            4000
          ),
        finishedAt: new Date()
      }
    });
  }

  private async moveSchedule(
    db: { id: string; backupScheduleCron: string | null; backupScheduleDisabled: boolean },
    ns: string,
    oldCluster: string | null,
    newCluster: string
  ) {
    if (!db.backupScheduleDisabled) {
      const cron = db.backupScheduleCron || defaultBackupCronFor(ns, newCluster);
      try {
        await this.k8sCnpg.upsertScheduledBackup(ns, newCluster, toQuartzCron(cron), {
          immediate: true
        });
        await this.prisma.database.update({
          where: { id: db.id },
          data: { backupScheduleCron: cron }
        });
      } catch (e: any) {
        this.logger.warn(`schedule for ${ns}/${newCluster} failed: ${k8sErrorMessage(e)}`);
      }
    }
    if (oldCluster) {
      await this.k8sCnpg
        .deleteScheduledBackup(ns, oldCluster, { keepBackups: true })
        .catch((e: any) => {
          this.logger.warn(`old schedule ${ns}/${oldCluster} not removed: ${k8sErrorMessage(e)}`);
        });
    }
  }

  private async removeTarget(op: DatabaseOperation) {
    const ns = op.targetNamespace;
    const name = op.targetClusterName;
    const src = op.source as unknown as OperationSource;
    const isSource = ns === src.namespace && name === src.clusterName;
    const backsADatabase =
      ns && name
        ? await this.prisma.database.findFirst({
            where: {
              namespace: ns,
              clusterName: name,
              status: { notIn: ['restoring'] }
            },
            select: { id: true }
          })
        : null;
    if (isSource || backsADatabase) {
      this.logger.warn(`refusing to remove ${ns}/${name}: it holds a live database`);
    } else if (ns && name) {
      await this.k8sCnpg.deleteCnpgCluster(ns, name);
      await this.k8sCnpg.deleteObjectStore(ns, objectStoreName(name)).catch(() => {});
      await this.k8sCnpg.deleteObjectStore(ns, `${name}-origin`.slice(0, 63)).catch(() => {});
      const secrets = liveCloneSecretNames(name);
      await this.k8sCnpg.deleteSecret(ns, secrets.replication).catch(() => {});
      await this.k8sCnpg.deleteSecret(ns, secrets.ca).catch(() => {});
    }
    if (op.storageAccessKey) {
      await this.prisma.storageAccessKey.deleteMany({ where: { accessKey: op.storageAccessKey } });
    }
  }

  async fail(op: DatabaseOperation, message: string) {
    const src = op.source as unknown as OperationSource;
    this.logger.warn(`operation ${op.id} (${op.kind}) failed: ${message}`);
    if (op.kind === 'upgrade' && !op.phase.startsWith('rehearsal_') && op.phase !== 'queued') {
      if (op.phase === 'upgrade_waiting') {
        await this.revertUpgrade(op, message);
        return;
      }
      await this.prisma.database
        .updateMany({
          where: { id: src.databaseId ?? '', status: 'upgrading' },
          data: { status: 'ready' }
        })
        .catch(() => {});
      await this.prisma.databaseOperation.update({
        where: { id: op.id },
        data: {
          status: 'failed',
          phase: 'done',
          error: message.slice(0, 4000),
          finishedAt: new Date()
        }
      });
      return;
    }
    await this.removeTarget(op).catch((e: any) => {
      this.logger.warn(`cleanup of operation ${op.id} failed: ${k8sErrorMessage(e)}`);
    });
    if (op.kind === 'restore' && op.mode !== 'fork' && src.databaseId) {
      await this.prisma.database
        .updateMany({
          where: { id: src.databaseId, status: 'restoring' },
          data: { status: 'ready' }
        })
        .catch(() => {});
    }
    if (
      (op.kind === 'fork' || op.kind === 'undelete' || op.mode === 'fork') &&
      op.targetDatabaseId
    ) {
      await this.prisma.database
        .deleteMany({ where: { id: op.targetDatabaseId, status: 'restoring' } })
        .catch(() => {});
    }
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        status: 'failed',
        phase: 'done',
        error: message.slice(0, 4000),
        finishedAt: new Date()
      }
    });
  }

  async cancel(id: string) {
    const op = await this.get(id);
    if (!op) throw new NotFoundException('Operation not found');
    if (!ACTIVE.includes(op.status)) return op;
    if (op.phase === 'cutting_over' || op.phase === 'finalizing') {
      throw new BadRequestException("The operation is finishing, so you can't cancel it");
    }
    await this.fail(op, 'Cancelled');
    return this.get(id);
  }

  private async retireOldClusters() {
    const done = await this.prisma.databaseOperation.findMany({
      where: { kind: 'restore', status: 'succeeded', mode: { not: 'fork' } },
      orderBy: { finishedAt: 'desc' },
      take: 50
    });
    for (const op of done) {
      const retired = (op.result as any)?.retired;
      if (!retired || retired.deleted || Date.parse(retired.retireAfter) > Date.now()) continue;
      try {
        const stillLive = await this.prisma.database.findFirst({
          where: { namespace: retired.namespace, clusterName: retired.clusterName },
          select: { id: true }
        });
        if (stillLive) {
          this.logger.warn(
            `not retiring ${retired.namespace}/${retired.clusterName}: it holds a live database`
          );
          await this.prisma.databaseOperation.update({
            where: { id: op.id },
            data: {
              result: {
                ...(op.result as object),
                retired: { ...retired, deleted: true, skipped: 'live' }
              } as Prisma.InputJsonValue
            }
          });
          continue;
        }
        await this.k8sCnpg.deleteScheduledBackup(retired.namespace, retired.clusterName, {
          keepBackups: true
        });
        await this.k8sCnpg.deleteCnpgCluster(retired.namespace, retired.clusterName);
        await this.k8sCnpg
          .deleteObjectStore(retired.namespace, objectStoreName(retired.clusterName))
          .catch(() => {});
        await this.prisma.databaseOperation.update({
          where: { id: op.id },
          data: {
            result: {
              ...(op.result as object),
              retired: { ...retired, deleted: true }
            } as Prisma.InputJsonValue
          }
        });
      } catch (e: any) {
        this.logger.warn(
          `retiring ${retired.namespace}/${retired.clusterName} failed: ${k8sErrorMessage(e)}`
        );
      }
    }
  }

  async undoRestore(opId: string) {
    const op = await this.get(opId);
    if (!op || op.kind !== 'restore' || op.status !== 'succeeded') {
      throw new NotFoundException('No finished restore with that id');
    }
    const retired = (op.result as any)?.retired;
    if (!retired || retired.deleted) {
      throw new BadRequestException('The previous copy has already been removed');
    }
    const src = op.source as unknown as OperationSource;
    const db = await this.prisma.database.findUnique({ where: { id: src.databaseId! } });
    if (!db) throw new NotFoundException('Database not found');
    await this.k8sCnpg.patchCluster(retired.namespace, retired.clusterName, {
      metadata: { annotations: { 'cnpg.io/hibernation': 'off' } }
    });
    const current = db.clusterName!;
    await this.prisma.database.update({
      where: { id: db.id },
      data: {
        clusterName: retired.clusterName,
        host: `${retired.clusterName}-rw.${retired.namespace}.svc.cluster.local`,
        status: 'restarting',
        ddlGuardVersion: null,
        ...(await this.clusterMirrorFields(retired.namespace, retired.clusterName)),
        backupServerName: src.serverName,
        r2ProxyAccessKey: null,
        r2ProxySecret: null
      }
    });
    const dbs = await this.databases();
    await dbs.repairBackupTarget(db.id).catch(() => {});
    await dbs.followCredentialChange(db.id, 'restore').catch(() => {});
    await this.moveSchedule(db, retired.namespace, current, retired.clusterName);
    await dbs.movePublicExposure(db.id, current).catch(() => {});
    await this.k8sCnpg.patchCluster(retired.namespace, current, {
      metadata: { annotations: { 'cnpg.io/hibernation': 'on' } }
    });
    await this.prisma.databaseOperation.update({
      where: { id: op.id },
      data: {
        result: {
          ...(op.result as object),
          undone: new Date().toISOString(),
          retired: {
            namespace: retired.namespace,
            clusterName: current,
            retireAfter: new Date(Date.now() + RETIRE_AFTER_MS).toISOString()
          }
        } as Prisma.InputJsonValue
      }
    });
    return this.get(opId);
  }
}

export function currentServerName(cluster: any): string | null {
  const plugin = (cluster?.spec?.plugins ?? []).find((p: any) => p?.isWALArchiver);
  if (plugin) return plugin.parameters?.serverName || cluster?.metadata?.name || null;
  const store = cluster?.spec?.backup?.barmanObjectStore;
  if (store) return store.serverName || cluster?.metadata?.name || null;
  return null;
}

export function upgradedServerName(previous: string, major: number): string {
  return `${previous.replace(/-pg\d+$/, '')}-pg${major}`.slice(0, 100);
}

export function serverNamePatch(cluster: any, serverName: string): Record<string, unknown> {
  const plugins: any[] = cluster?.spec?.plugins ?? [];
  if (plugins.some((p) => p?.isWALArchiver)) {
    return {
      plugins: plugins.map((p) =>
        p?.isWALArchiver ? { ...p, parameters: { ...(p.parameters ?? {}), serverName } } : p
      )
    };
  }
  if (cluster?.spec?.backup?.barmanObjectStore) {
    return { backup: { barmanObjectStore: { serverName } } };
  }
  return {};
}
