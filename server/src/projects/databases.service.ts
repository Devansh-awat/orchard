import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { R2ProxyService } from '../kubernetes/r2-proxy.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { QuotasService } from '../quotas/quotas.service';
import { ProjectAccessService } from './project-access.service';
import { formatSlug, redactDatabaseForViewer, stripR2ProxyCreds } from './projects.utils';

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
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
  ) {}

  // ── Database (PostgreSQL) Management ──

  private readonly TARGET_PG_MAJOR = 17;

  /**
   * Build the R2/backup config object that gets handed to the in-cluster
   * barman sidecar. When the r2-proxy is enabled we mint a per-cluster fake
   * AK/SK, register a binding with the proxy ConfigMap, and tell the cluster
   * to talk to the proxy instead of real R2 — so real R2 credentials never
   * land in the tenant's namespace.
   */
  private async buildBackupR2Config(
    org: {
      backupR2Endpoint: string | null;
      backupR2Bucket: string | null;
      backupR2Region: string | null;
      backupR2AccessKey: string | null;
      backupR2SecretKey: string | null;
    } | null | undefined,
    namespace: string,
    clusterName: string,
  ): Promise<{
    r2: {
      endpoint: string;
      bucket: string;
      region: string;
      accessKey: string;
      secretKey: string;
    } | undefined;
    r2ProxyAccessKey: string | undefined;
    r2ProxySecret: string | undefined;
  }> {
    if (
      !org?.backupR2Endpoint ||
      !org?.backupR2Bucket ||
      !org?.backupR2AccessKey ||
      !org?.backupR2SecretKey
    ) {
      return { r2: undefined, r2ProxyAccessKey: undefined, r2ProxySecret: undefined };
    }

    if (this.r2Proxy.isEnabled()) {
      const minted = this.r2Proxy.mintCredentials();
      await this.r2Proxy.addBinding({
        accessKey: minted.accessKey,
        secret: minted.secret,
        bucket: org.backupR2Bucket,
        prefix: `${namespace}/${clusterName}/`,
      });
      return {
        r2: {
          endpoint: this.r2Proxy.getEndpoint(),
          bucket: org.backupR2Bucket,
          region: org.backupR2Region || 'auto',
          accessKey: minted.accessKey,
          secretKey: minted.secret,
        },
        r2ProxyAccessKey: minted.accessKey,
        r2ProxySecret: minted.secret,
      };
    }

    return {
      r2: {
        endpoint: org.backupR2Endpoint,
        bucket: org.backupR2Bucket,
        region: org.backupR2Region || 'auto',
        accessKey: org.backupR2AccessKey,
        secretKey: org.backupR2SecretKey,
      },
      r2ProxyAccessKey: undefined,
      r2ProxySecret: undefined,
    };
  }

  private async validateImportSource(src: {
    host: string;
    port?: number;
    user: string;
    password: string;
    database: string;
    sslMode?: string;
  }): Promise<void> {
    const { Client } = require('pg');
    const ssl = src.sslMode && src.sslMode !== 'disable'
      ? { rejectUnauthorized: false }
      : false;
    const client = new Client({
      host: src.host,
      port: src.port || 5432,
      user: src.user,
      password: src.password,
      database: src.database,
      ssl,
      connectionTimeoutMillis: 8000,
      statement_timeout: 5000,
      query_timeout: 5000,
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
          throw new BadRequestException(`Source database refused connection at ${src.host}:${src.port || 5432}`);
        }
        if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
          throw new BadRequestException(`Timed out connecting to source database at ${src.host}:${src.port || 5432}`);
        }
        if (code === '28P01' || code === '28000') {
          throw new BadRequestException('Source database rejected credentials (wrong user or password)');
        }
        if (code === '3D000') {
          throw new BadRequestException(`Source database "${src.database}" does not exist`);
        }
        if (/self.signed|self-signed|certificate/i.test(msg)) {
          throw new BadRequestException(`Source database TLS error: ${msg}. Try appending ?sslmode=require to the URL.`);
        }
        throw new BadRequestException(`Cannot reach source database: ${msg}`);
      }

      let versionNum: number | null = null;
      try {
        const r = await client.query('SHOW server_version_num');
        versionNum = Number(r.rows?.[0]?.server_version_num);
      } catch (e: any) {
        throw new BadRequestException(`Failed to query source database version: ${e?.message || e}`);
      }
      if (!versionNum || Number.isNaN(versionNum)) {
        throw new BadRequestException('Could not determine source PostgreSQL version');
      }
      const sourceMajor = Math.floor(versionNum / 10000);
      if (sourceMajor > this.TARGET_PG_MAJOR) {
        throw new BadRequestException(
          `Source PostgreSQL major version (${sourceMajor}) is newer than the target (${this.TARGET_PG_MAJOR}); import is not supported.`,
        );
      }
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  }

  private generatePassword(length = 24): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = require('crypto').randomBytes(length);
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
      include: { organization: true },
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

    // Check uniqueness in our records
    const existing = await this.prisma.database.findUnique({
      where: { projectId_name: { projectId, name: nameInput } },
    });
    if (existing) throw new BadRequestException('A database with this name already exists in this project');

    const dbNameExists = await this.prisma.database.findUnique({
      where: { dbName },
    });
    if (dbNameExists) throw new BadRequestException('A database with this identifier already exists');

    // New databases get a dedicated CNPG Cluster in the project namespace.
    // K8s resource name must match DNS-1123 (lowercase, hyphens, ≤53 chars to leave room for suffixes).
    const clusterName = `pg-${formatSlug(nameInput).substring(0, 48)}`.replace(/^-+|-+$/g, '');
    const namespace = project.namespace;

    const org = await this.prisma.organization.findUnique({ where: { id: project.organizationId } });
    const { r2, r2ProxyAccessKey, r2ProxySecret } = await this.buildBackupR2Config(
      org,
      namespace,
      clusterName,
    );

    const sizeRaw = typeof data.storageSize === 'string' ? data.storageSize.trim() : '';
    const storageSize = /^\d+(Mi|Gi|Ti)$/.test(sizeRaw) ? sizeRaw : '1Gi';

    const dbResources = await this.quotasService.resolvePodResources(projectId, {
      cpuRequestMilli: data.cpuRequestMilli ?? null,
      memoryRequestBytes: data.memoryRequestBytes ?? null,
    });
    await this.quotasService.enforceOrgCapForNewPod(project.organizationId, {
      cpuMilli: dbResources.cpuMilli,
      memoryBytes: dbResources.memoryBytes,
    });
    await this.quotasService.enforceMemberAllowanceForNewPod(
      project.organizationId,
      project.ownerId,
      { cpuMilli: dbResources.cpuMilli, memoryBytes: dbResources.memoryBytes },
    );
    await this.quotasService.applyProjectQuota(projectId).catch((err) => {
      console.error('[Projects] applyProjectQuota (db) failed:', err);
    });

    let importFrom: {
      host: string;
      port?: number;
      user: string;
      password: string;
      database: string;
      sslMode?: string;
    } | undefined;
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
          sslMode: u.searchParams.get('sslmode') || undefined,
        };
      } catch (e: any) {
        throw new BadRequestException(`Invalid restore URL: ${e?.message || 'parse error'}`);
      }
    }

    if (importFrom) {
      await this.validateImportSource(importFrom);
    }

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
        resources: dbResources,
        importFrom,
      }));
    } catch (e) {
      if (r2ProxyAccessKey) {
        try { await this.r2Proxy.removeBinding(r2ProxyAccessKey); } catch (cleanupErr: any) {
          console.warn(`[R2Proxy] Failed to remove binding ${r2ProxyAccessKey} after createCnpgCluster failure: ${cleanupErr?.message}`);
        }
      }
      throw e;
    }

    let database;
    try {
      database = await this.prisma.database.create({
        data: {
          projectId,
          name: nameInput,
          dbName,
          dbUser,
          dbPassword,
          status: 'provisioning',
          mode: 'cnpg',
          namespace,
          clusterName,
          storageSize,
          cpuRequestMilli: data.cpuRequestMilli ?? null,
          memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
          host,
          port,
          createdBy: user.id,
          templateInstanceId: data.templateInstanceId ?? null,
          r2ProxyAccessKey: r2ProxyAccessKey ?? null,
          r2ProxySecret: r2ProxySecret ?? null,
        },
        include: {
          creator: {
            select: { id: true, email: true, username: true, firstName: true, lastName: true },
          },
        },
      });
    } catch (e) {
      try { await this.k8sCnpg.deleteScheduledBackup(namespace, clusterName); } catch { /* ignore */ }
      try { await this.k8sNetwork.unexposeCnpgCluster(namespace, clusterName); } catch { /* ignore */ }
      try { await this.k8sCnpg.deleteCnpgCluster(namespace, clusterName); } catch { /* ignore */ }
      if (r2ProxyAccessKey) {
        try { await this.r2Proxy.removeBinding(r2ProxyAccessKey); } catch (cleanupErr: any) {
          console.warn(`[R2Proxy] Failed to remove binding ${r2ProxyAccessKey} after createDatabase rollback: ${cleanupErr?.message}`);
        }
      }
      throw e;
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
      metadata: { mode: 'cnpg', storageSize },
    });

    return stripR2ProxyCreds(database as any);
  }

  async getDatabase(databaseId: string, canEdit: boolean = true, userId?: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: { include: { organization: true } },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
    });

    if (!database) throw new NotFoundException('Database not found');

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(database.projectId, userId);
    }

    let liveStatus: any;
    let pods: any[] = [];
    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      liveStatus = await this.k8sCnpg.getCnpgClusterStatus(database.namespace, database.clusterName);
      try {
        const podList = await this.k8sWorkload.listPods(database.namespace);
        pods = (podList?.pods || []).filter((p: any) =>
          p.labels?.['cnpg.io/cluster'] === database.clusterName,
        );
      } catch { /* ignore */ }

      // Reconcile stored status with live cluster state.
      // 'restarting' flips to 'ready' once the new pod becomes ready — same path
      // as initial provisioning, just from a different starting state.
      if (liveStatus.ready && database.status !== 'ready' && database.status !== 'restoring') {
        try {
          await this.prisma.database.update({ where: { id: database.id }, data: { status: 'ready' } });
          database.status = 'ready';
        } catch { /* ignore */ }
      } else if (!liveStatus.exists && database.status !== 'error') {
        try {
          await this.prisma.database.update({ where: { id: database.id }, data: { status: 'error' } });
          database.status = 'error';
        } catch { /* ignore */ }
      }
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      liveStatus = await this.k8sCnpg.getPostgresContainerStatus(
        database.namespace,
        database.containerName,
        database.dbName,
        database.dbUser,
      );
      try {
        const podData = await this.k8sWorkload.getDeploymentPods(
          database.containerName,
          database.namespace,
        );
        pods = podData?.pods || [];
      } catch { /* ignore */ }
    } else {
      liveStatus = await this.k8sCnpg.getPostgresDatabaseStatus(database.dbName);
    }

    const org = await this.prisma.organization.findUnique({ where: { id: database.project.organizationId } });
    const backupsEnabled = Boolean(
      (database.mode === 'cnpg' || database.mode === 'container') &&
      org?.backupR2Endpoint && org?.backupR2Bucket && org?.backupR2AccessKey && org?.backupR2SecretKey
    );

    let publicHostname: string | null = null;
    let publicConnectionString: string | null = null;
    if (database.publicEnabled && database.publicIp && database.publicPort && database.mode === 'cnpg' && database.clusterName && database.namespace) {
      publicHostname = this.k8sCnpg.publicTlsHostname(database.clusterName);
      publicConnectionString = `postgresql://${database.dbUser}:${database.dbPassword}@${publicHostname}:${database.publicPort}/${database.dbName}?sslmode=verify-full&sslrootcert=system`;
      // Opportunistically refresh the local TLS secret copy if cert-manager rotated it.
      try {
        await this.k8sCnpg.syncPublicTlsSecret(database.namespace);
      } catch { /* ignore */ }
    }

    const result: any = {
      ...database,
      connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${database.host}:${database.port}/${database.dbName}`,
      internalHost: `${database.host}:${database.port}`,
      publicHostname,
      publicConnectionString,
      liveStatus,
      backupsEnabled,
      pods,
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

  async getDatabaseProvisioning(databaseId: string, userId?: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
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
        events: [],
      };
    }

    const k = await this.k8sCnpg.getCnpgProvisioningStatus(
      database.namespace,
      database.clusterName,
      { fetchImportLogs: true },
    );

    // Mirror the reconciliation that getDatabase() performs so polling this
    // endpoint alone is enough to flip 'provisioning' → 'ready' once CNPG is up.
    if (k.ready && database.status !== 'ready' && database.status !== 'restoring') {
      try {
        await this.prisma.database.update({ where: { id: database.id }, data: { status: 'ready' } });
        database.status = 'ready';
      } catch { /* ignore */ }
    } else if (!k.exists && database.status !== 'error' && database.status !== 'provisioning') {
      try {
        await this.prisma.database.update({ where: { id: database.id }, data: { status: 'error' } });
        database.status = 'error';
      } catch { /* ignore */ }
    }

    type StepStatus = 'pending' | 'running' | 'done' | 'error';
    interface Step {
      id: string;
      label: string;
      description: string;
      status: StepStatus;
      detail?: string;
    }

    const podWaiting = k.instancePod?.waiting;
    const podStuck =
      podWaiting && /(Err|BackOff|Failed|InvalidImage)/i.test(podWaiting.reason || '');

    const steps: Step[] = [];

    steps.push({
      id: 'cluster',
      label: 'Cluster resource created',
      description: 'Registering the Postgres cluster with Kubernetes.',
      status: k.exists ? 'done' : database.status === 'error' ? 'error' : 'running',
    });

    steps.push({
      id: 'storage',
      label: 'Storage volume attached',
      description: 'Provisioning and binding the PersistentVolumeClaim.',
      status: k.pvc.bound
        ? 'done'
        : k.pvc.exists
          ? 'running'
          : k.exists
            ? 'running'
            : 'pending',
      detail: k.pvc.exists && !k.pvc.bound ? `PVC ${k.pvc.phase || 'Pending'}` : undefined,
    });

    steps.push({
      id: 'pod-scheduled',
      label: 'Pod scheduled to a node',
      description: 'Kubernetes is placing the Postgres pod onto a worker.',
      status: k.instancePod?.scheduled
        ? 'done'
        : k.instancePod
          ? 'running'
          : 'pending',
      detail: k.instancePod?.nodeName ? `Scheduled on ${k.instancePod.nodeName}` : undefined,
    });

    steps.push({
      id: 'pod-running',
      label: 'Postgres container running',
      description: 'Pulling the Postgres image and starting the container.',
      status: k.instancePod?.running
        ? 'done'
        : podStuck
          ? 'error'
          : k.instancePod?.scheduled
            ? 'running'
            : 'pending',
      detail: podWaiting
        ? `${podWaiting.reason}${podWaiting.message ? ': ' + podWaiting.message : ''}`
        : undefined,
    });

    if (k.hasImport) {
      steps.push({
        id: 'import',
        label: 'Migrating data from source database',
        description: 'CloudNativePG is dumping the source DB and restoring into this cluster.',
        status:
          k.importStatus === 'completed'
            ? 'done'
            : k.importStatus === 'failed'
              ? 'error'
              : k.importStatus === 'running'
                ? 'running'
                : 'pending',
      });
    }

    steps.push({
      id: 'ready',
      label: 'Database accepting connections',
      description: 'Bootstrap is complete and the cluster is healthy.',
      status: k.ready ? 'done' : k.instancePod?.ready ? 'running' : 'pending',
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
      importPod: k.importPod,
    };
  }

  async getProjectDatabases(projectId: string, canEdit: boolean = true, userId?: string) {
    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(projectId, userId);
    }
    const databases = await this.prisma.database.findMany({
      where: { projectId },
      include: {
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Lightweight liveStatus enrichment so the list view can surface OOM/crash
    // states (the persisted `status` says "ready" even while pods OOM-cycle).
    // Best-effort + parallel; failures fall through silently.
    const enriched = await Promise.all(
      databases.map(async (d: any) => {
        if (d.mode === 'cnpg' && d.namespace && d.clusterName) {
          try {
            const ls = await this.k8sCnpg.getCnpgClusterStatus(d.namespace, d.clusterName);
            return { ...d, liveStatus: ls };
          } catch { return d; }
        }
        return d;
      }),
    );

    if (!canEdit) {
      return enriched.map((d) => redactDatabaseForViewer(d as any));
    }
    // Strip R2 proxy backup credentials from editor returns as well — they
    // are infrastructure secrets, not user-facing data.
    return enriched.map((d) => stripR2ProxyCreds(d as any));
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
      include: { project: { include: { organization: true } } },
    });
    if (!database) throw new NotFoundException('Database not found');

    await this.authz.requireProjectEdit(database.project.id, user.id, 'delete databases');

    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      try { await this.k8sCnpg.deleteScheduledBackup(database.namespace, database.clusterName); } catch { /* ignore */ }
      try { await this.k8sNetwork.unexposeCnpgCluster(database.namespace, database.clusterName); } catch { /* ignore */ }
      await this.k8sCnpg.deleteCnpgCluster(database.namespace, database.clusterName);
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      await this.k8sCnpg.deletePostgresContainer(database.namespace, database.containerName);
    } else {
      await this.k8sCnpg.deletePostgresDatabase(database.dbName, database.dbUser);
    }

    if (database.r2ProxyAccessKey) {
      try {
        await this.r2Proxy.removeBinding(database.r2ProxyAccessKey);
      } catch (e: any) {
        console.warn(`[R2Proxy] Failed to remove binding ${database.r2ProxyAccessKey} during deleteDatabase: ${e?.message}`);
      }
    }

    await this.prisma.database.delete({ where: { id: databaseId } });

    void this.audit.log({
      action: 'database.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name,
    });

    return { success: true, message: `Database "${database.name}" deleted` };
  }

  // ── Database backup management ──

  private async getOrgR2Config(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org?.backupR2Endpoint || !org?.backupR2Bucket || !org?.backupR2AccessKey || !org?.backupR2SecretKey) {
      throw new BadRequestException('R2 backup storage is not configured for this organization');
    }
    return org;
  }

  async listDatabaseBackups(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(databaseId, clerkId, userData, { allowViewer: true });
    const records = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id },
      orderBy: { createdAt: 'desc' },
    });

    // For CNPG, reconcile our records with live status from the Backup CRs.
    // Also, pick up any scheduled backups created directly by CNPG that we don't yet have a record for.
    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      let anyNewlyCompleted = false;

      const runningOrPending = records.filter((r) => r.status === 'running' || r.status === 'pending');
      for (const r of runningOrPending) {
        try {
          const live = await this.k8sCnpg.getCnpgBackup(database.namespace, r.backupName);
          if (!live) continue;
          const phase: string | undefined = live.status?.phase;
          if (!phase) continue;
          let newStatus: string | null = null;
          if (phase === 'completed') newStatus = 'completed';
          else if (phase === 'failed') newStatus = 'failed';
          else if (phase === 'running' || phase === 'started') newStatus = 'running';
          if (newStatus && newStatus !== r.status) {
            const completedAt = newStatus === 'completed' || newStatus === 'failed' ? new Date() : r.completedAt;
            const errorMessage = newStatus === 'failed' ? (live.status?.error || '').substring(0, 2000) : r.errorMessage;
            await this.prisma.databaseBackup.update({
              where: { id: r.id },
              data: { status: newStatus, completedAt, errorMessage },
            });
            r.status = newStatus;
            r.completedAt = completedAt || null;
            if (errorMessage !== undefined) r.errorMessage = errorMessage || null;
            if (newStatus === 'completed') anyNewlyCompleted = true;
          }
        } catch { /* ignore */ }
      }

      try {
        const liveBackups = await this.k8sCnpg.listCnpgBackups(database.namespace, database.clusterName);
        const known = new Set(records.map((r) => r.backupName));
        for (const lb of liveBackups) {
          const name: string | undefined = lb.metadata?.name;
          if (!name || known.has(name)) continue;
          const phase: string | undefined = lb.status?.phase;
          const status = phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'running';
          const completedAt = (status === 'completed' || status === 'failed') ? new Date(lb.status?.stoppedAt || Date.now()) : null;
          try {
            const created = await this.prisma.databaseBackup.create({
              data: {
                databaseId: database.id,
                label: name,
                backupName: name,
                type: lb.metadata?.labels?.['cnpg.io/scheduled-backup'] ? 'scheduled' : 'full',
                status,
                completedAt,
                createdAt: new Date(lb.metadata?.creationTimestamp || Date.now()),
              },
            });
            records.unshift(created);
            if (status === 'completed') anyNewlyCompleted = true;
          } catch { /* race: another request created it */ }
        }
      } catch { /* ignore */ }

      if (anyNewlyCompleted) {
        await this.pruneOldBackups({ id: database.id, namespace: database.namespace, clusterName: database.clusterName });
      }
    }

    return records;
  }

  private readonly MAX_COMPLETED_BACKUPS = 10;

  private async pruneOldBackups(database: { id: string; namespace: string | null; clusterName: string | null }) {
    if (!database.namespace || !database.clusterName) return;
    const completed = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });
    if (completed.length <= this.MAX_COMPLETED_BACKUPS) return;
    const toDelete = completed.slice(this.MAX_COMPLETED_BACKUPS);
    for (const b of toDelete) {
      try {
        await this.k8sCnpg.deleteCnpgBackup(database.namespace, b.backupName);
      } catch (e: any) {
        console.error(`[DB/backup] Failed to delete old backup CR ${b.backupName}: ${e?.message}`);
      }
      try {
        await this.prisma.databaseBackup.delete({ where: { id: b.id } });
      } catch (e: any) {
        console.error(`[DB/backup] Failed to delete old backup record ${b.id}: ${e?.message}`);
      }
    }
  }

  async createDatabaseBackup(
    databaseId: string,
    data: { label?: string; type?: 'full' | 'diff' | 'incr' },
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg') {
      throw new BadRequestException('Backups are only supported for CNPG-backed databases. Recreate this database to enable backups.');
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    await this.getOrgR2Config(database.project.organizationId);

    await this.pruneOldBackups({ id: database.id, namespace: database.namespace, clusterName: database.clusterName });

    const backupName = (data.label || `backup-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`)
      .trim()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 63);

    const record = await this.prisma.databaseBackup.create({
      data: {
        databaseId: database.id,
        label: backupName,
        backupName,
        type: 'full',
        status: 'running',
        createdBy: user.id,
      },
    });

    try {
      await this.k8sCnpg.createCnpgBackup(database.namespace, database.clusterName, backupName);
    } catch (e: any) {
      await this.prisma.databaseBackup.update({
        where: { id: record.id },
        data: { status: 'failed', completedAt: new Date(), errorMessage: String(e?.message || e).substring(0, 2000) },
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
      metadata: { database: database.name },
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

  private toQuartzCron(expr: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length === 5) return `0 ${parts.join(' ')}`;
    return expr.trim();
  }

  async getBackupSchedule(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(databaseId, clerkId, userData, { allowViewer: true });
    return { cron: database.backupScheduleCron || null };
  }

  async setBackupSchedule(
    databaseId: string,
    data: { cron: string },
    clerkId: string,
    userData?: any,
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Scheduled backups require a CNPG-backed database');
    }
    await this.getOrgR2Config(database.project.organizationId);

    const cron = (data.cron || '').trim();
    if (!this.isValidCron(cron)) {
      throw new BadRequestException('Invalid cron expression. Expected 5 or 6 space-separated fields.');
    }

    const quartz = this.toQuartzCron(cron);
    await this.k8sCnpg.upsertScheduledBackup(database.namespace, database.clusterName, quartz);
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: cron },
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
      console.error(`[DB/schedule] Failed to delete ScheduledBackup: ${e?.message}`);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: null },
    });
    return { success: true };
  }

  async restoreDatabaseBackup(
    databaseId: string,
    backupId: string | undefined,
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg') {
      throw new BadRequestException('Restore is only supported for CNPG-backed databases');
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    if (!backupId) throw new BadRequestException('backupId is required');

    const org = await this.getOrgR2Config(database.project.organizationId);

    const backup = await this.prisma.databaseBackup.findUnique({ where: { id: backupId } });
    if (!backup || backup.databaseId !== database.id) throw new NotFoundException('Backup not found');
    if (backup.status !== 'completed') throw new BadRequestException('Backup is not completed yet');

    const oldClusterName = database.clusterName;
    const oldR2ProxyAccessKey = database.r2ProxyAccessKey;

    await this.prisma.database.update({ where: { id: database.id }, data: { status: 'restoring' } });

    void this.audit.log({
      action: 'database.backup.restored',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: { backupId, backupName: backup.backupName },
    });

    // Predetermine the restore cluster name so we can mint a r2-proxy binding
    // for it (when the proxy is enabled) BEFORE the cluster spins up. The
    // suffix matches the format used inside restoreCnpgCluster.
    const restoreSuffix = Date.now().toString(36);
    const predictedNewClusterName = `${oldClusterName}-r${restoreSuffix}`.substring(0, 53);
    const restoreR2 = await this.buildBackupR2Config(
      org,
      database.namespace!,
      predictedNewClusterName,
    );

    (async () => {
      try {
        const { newClusterName, host, port } = await this.k8sCnpg.restoreCnpgCluster(
          database.namespace!, oldClusterName, backup.backupName,
          {
            dbName: database.dbName,
            dbUser: database.dbUser,
            dbPassword: database.dbPassword,
            storageSize: database.storageSize || '1Gi',
            parameters: (database.pgParameters as Record<string, string> | null) || undefined,
            sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || undefined,
            r2: restoreR2.r2,
            newClusterName: predictedNewClusterName,
          },
        );

        // Wait for the new cluster to come up healthy before cutting over.
        const deadline = Date.now() + 10 * 60 * 1000;
        let healthy = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          const status = await this.k8sCnpg.getCnpgClusterStatus(database.namespace!, newClusterName);
          if (status.exists && status.ready) { healthy = true; break; }
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
          },
        });

        try {
          await this.k8sCnpg.deleteCnpgCluster(database.namespace!, oldClusterName);
        } catch (e: any) {
          console.error(`[DB] Failed to delete old cluster ${oldClusterName}: ${e?.message}`);
        }

        // Old cluster is gone — its proxy binding is no longer needed.
        if (oldR2ProxyAccessKey && oldR2ProxyAccessKey !== restoreR2.r2ProxyAccessKey) {
          try { await this.r2Proxy.removeBinding(oldR2ProxyAccessKey); } catch (cleanupErr: any) {
            console.warn(`[R2Proxy] Failed to remove old binding ${oldR2ProxyAccessKey} after restore: ${cleanupErr?.message}`);
          }
        }
      } catch (e: any) {
        console.error(`[DB] Restore failed: ${e?.message}`);
        if (restoreR2.r2ProxyAccessKey) {
          try { await this.r2Proxy.removeBinding(restoreR2.r2ProxyAccessKey); } catch (cleanupErr: any) {
            console.warn(`[R2Proxy] Failed to remove new binding ${restoreR2.r2ProxyAccessKey} after restore failure: ${cleanupErr?.message}`);
          }
        }
        await this.prisma.database.update({ where: { id: database.id }, data: { status: 'error' } });
      }
    })();

    return { success: true, message: 'Restore initiated — a new cluster will be provisioned from the backup and cut over when ready.' };
  }

  // ── Extensions ──

  async listDatabaseExtensions(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(databaseId, clerkId, userData, { allowViewer: true });
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { extensions: [], sharedPreloadLibraries: [] };
    }
    const extensions = await this.k8sCnpg.listCnpgExtensions(
      database.namespace, database.clusterName, database.dbName,
    );
    return {
      extensions,
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || [],
    };
  }

  async installDatabaseExtension(
    databaseId: string,
    data: { name: string; addToPreload?: boolean },
    clerkId: string,
    userData?: any,
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
      'pgvector', 'vector',
      'citext', 'hstore', 'ltree', 'pg_trgm', 'unaccent', 'btree_gin', 'btree_gist',
      'uuid-ossp', 'pgcrypto',
      'tablefunc', 'fuzzystrmatch', 'pg_stat_statements',
      'postgis', 'postgis_topology', 'postgis_raster',
      'plpgsql',
      'intarray', 'isn', 'cube', 'earthdistance',
      'timescaledb',
    ]);
    if (!ALLOWED_EXTENSIONS.has(data.name)) {
      throw new BadRequestException(
        `Extension "${data.name}" is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}`,
      );
    }

    let preloadAdded = false;
    if (data.addToPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).slice();
      if (!existing.includes(data.name)) {
        existing.push(data.name);
        await this.k8sCnpg.updateCnpgParameters(
          database.namespace, database.clusterName,
          (database.pgParameters as Record<string, string> | null) || {},
          existing,
        );
        await this.prisma.database.update({
          where: { id: database.id },
          data: { sharedPreloadLibs: existing },
        });
        preloadAdded = true;
      }
    }

    const result = await this.k8sCnpg.installCnpgExtension(
      database.namespace, database.clusterName, database.dbName, data.name,
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
    userData?: any,
  ) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Extensions require a CNPG-backed database');
    }
    if (!data.name) throw new BadRequestException('name is required');

    const result = await this.k8sCnpg.uninstallCnpgExtension(
      database.namespace, database.clusterName, database.dbName, data.name,
    );

    if (data.removeFromPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).filter((x) => x !== data.name);
      await this.k8sCnpg.updateCnpgParameters(
        database.namespace, database.clusterName,
        (database.pgParameters as Record<string, string> | null) || {},
        existing,
      );
      await this.prisma.database.update({
        where: { id: database.id },
        data: { sharedPreloadLibs: existing },
      });
    }

    return { success: result.success, output: result.output };
  }

  // ── Settings ──

  async getDatabaseSettings(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.access.assertDatabaseEditorOrViewer(databaseId, clerkId, userData, { allowViewer: true });
    if (database.mode !== 'cnpg') {
      return { parameters: {}, sharedPreloadLibraries: [] };
    }
    // Settings (pg_parameters / shared_preload_libs) are not credentials, no extra redaction needed.
    return {
      parameters: (database.pgParameters as Record<string, string> | null) || {},
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || [],
    };
  }

  async updateDatabaseSettings(
    databaseId: string,
    data: { parameters: Record<string, string> },
    clerkId: string,
    userData?: any,
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

    const existingPreload = (database.sharedPreloadLibs as string[] | null) || [];
    await this.k8sCnpg.updateCnpgParameters(
      database.namespace, database.clusterName, sanitized, existingPreload,
    );
    await this.prisma.database.update({
      where: { id: database.id },
      data: { pgParameters: sanitized },
    });

    return { success: true, parameters: sanitized };
  }

  // ── Public (MetalLB) exposure ──

  private readonly PUBLIC_PORT_MIN = 30000;
  private readonly PUBLIC_PORT_MAX = 32767;

  private async pickFreePublicPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const dbPorts = new Set(dbPortsRaw.map((r) => r.publicPort).filter((n): n is number => typeof n === 'number'));

    let livePorts = new Set<number>();
    try {
      livePorts = new Set(await this.k8sNetwork.listInUsePortsOnIp(ip));
    } catch (e: any) {
      console.error(`[DB/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    for (let i = 0; i < 200; i++) {
      const port = Math.floor(Math.random() * (this.PUBLIC_PORT_MAX - this.PUBLIC_PORT_MIN + 1)) + this.PUBLIC_PORT_MIN;
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

    const org = await this.prisma.organization.findUnique({ where: { id: database.project.organizationId } });
    const ip = (org?.databasePublicIp || '').trim();
    if (!ip) {
      throw new BadRequestException('This organization does not have a public database IP configured. Set one in organization settings.');
    }

    if (database.publicEnabled && database.publicIp === ip && database.publicPort) {
      return {
        enabled: true,
        host: database.publicIp,
        port: database.publicPort,
        connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${database.publicIp}:${database.publicPort}/${database.dbName}`,
      };
    }

    const port = database.publicIp === ip && database.publicPort
      ? database.publicPort
      : await this.pickFreePublicPort(ip);

    await this.k8sNetwork.exposeCnpgClusterPublic({
      namespace: database.namespace,
      clusterName: database.clusterName,
      loadBalancerIp: ip,
      port,
    });

    // Punch a hole in the namespace's default-deny-all NetworkPolicy so external
    // clients can actually reach port 5432 on the primary pod.
    try {
      await this.k8sNetwork.upsertPublicDatabaseNetworkPolicy(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to create ingress NetworkPolicy: ${e?.message}`);
    }

    // Copy the wildcard TLS secret into the project namespace and wire it into the CNPG Cluster
    // so Postgres serves the Let's Encrypt cert instead of its self-signed default.
    const hostname = this.k8sCnpg.publicTlsHostname(database.clusterName);
    try {
      await this.k8sCnpg.syncPublicTlsSecret(database.namespace);
      await this.k8sCnpg.patchCnpgClusterTls(database.namespace, database.clusterName, [hostname]);
    } catch (e: any) {
      console.error(`[DB/public] Failed to configure TLS: ${e?.message}`);
    }

    await this.prisma.database.update({
      where: { id: database.id },
      data: { publicEnabled: true, publicIp: ip, publicPort: port },
    });

    return {
      enabled: true,
      host: hostname,
      ip,
      port,
      connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${hostname}:${port}/${database.dbName}?sslmode=verify-full&sslrootcert=system`,
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
      data: { publicEnabled: false, publicIp: null, publicPort: null },
    });
    return { enabled: false };
  }

  private readonly PG_PARAM_BOUNDS: Record<string, any> = {
    max_connections: { kind: 'int', min: 10, max: 500, requiresRestart: true },
    shared_buffers: { kind: 'memory', requiresRestart: true },
    work_mem: { kind: 'memory' },
    maintenance_work_mem: { kind: 'memory' },
    effective_cache_size: { kind: 'memory' },
    log_min_duration_statement: { kind: 'int', min: -1, max: 600000 },
    statement_timeout: { kind: 'int', min: 0, max: 3600000 },
    idle_in_transaction_session_timeout: { kind: 'int', min: 0, max: 3600000 },
    synchronous_commit: { kind: 'string', enum: ['on', 'off', 'local', 'remote_write', 'remote_apply'] },
  };
}
