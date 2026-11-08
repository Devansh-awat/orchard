import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { AuditService, type AuditMetadataValue } from '../audit/audit.service';
import { ProjectAccessService } from './project-access.service';
import { DatabaseOperationsService, type OperationTarget } from './database-operations.service';
import { DatabaseCheckpointsService } from './database-checkpoints.service';
import { DatabaseDrillsService } from './database-drills.service';
import { DatabaseTrashService } from './database-trash.service';
import { PostgresSecurityService } from './postgres-security.service';
import {
  securityReport,
  versionFromImage,
  versionFromServerVersionNum
} from '../kubernetes/postgres-advisories';
import {
  DEFAULT_POOLER,
  normalizePoolerConfig,
  poolerBody,
  poolerName,
  type PoolerConfig,
  restoreBlocker,
  type RestorePoint
} from '../kubernetes/cnpg-recovery';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import type { DatabasesService } from './databases.service';

export const ACTIVITY_SQL = `SELECT json_build_object(
  'sessions', (SELECT coalesce(json_agg(t), '[]'::json) FROM (
    SELECT pid, usename AS "user", application_name AS app, client_addr::text AS client, state,
           wait_event_type AS "waitType", wait_event AS "waitEvent",
           extract(epoch FROM now() - xact_start)::int AS "transactionSeconds",
           extract(epoch FROM now() - query_start)::int AS "querySeconds",
           left(query, 300) AS query
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
     ORDER BY query_start NULLS LAST
     LIMIT 100) t),
  'blocked', (SELECT coalesce(json_agg(t), '[]'::json) FROM (
    SELECT pid, pg_blocking_pids(pid) AS "blockedBy", left(query, 200) AS query,
           extract(epoch FROM now() - query_start)::int AS seconds
      FROM pg_stat_activity
     WHERE cardinality(pg_blocking_pids(pid)) > 0) t),
  'maxConnections', current_setting('max_connections')::int
)::text;`;

type UserData = Record<string, unknown> | undefined;

export type ReplicationMode = 'async' | 'preferred' | 'required';

export const REPLICATION_MODES: ReplicationMode[] = ['async', 'preferred', 'required'];

export function synchronousSpec(mode: ReplicationMode) {
  if (mode === 'async') return null;
  return { method: 'any', number: 1, dataDurability: mode };
}

export function replicationModeOf(synchronous: any): ReplicationMode {
  if (!synchronous || !synchronous.number) return 'async';
  return synchronous.dataDurability === 'preferred' ? 'preferred' : 'required';
}

export type RoleAccess = 'read' | 'write';

const ROLE_MARKER = 'orchard-user';

const RESERVED_ROLES = new Set([
  'postgres',
  'streaming_replica',
  'app',
  'datadog',
  'orchard_r2_proxy'
]);

export function assertRoleName(name: string, owner: string): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
    throw new BadRequestException(
      'User names are 2 to 41 lowercase letters, digits or underscores, starting with a letter'
    );
  }
  if (
    name === owner ||
    RESERVED_ROLES.has(name) ||
    name.startsWith('pg_') ||
    name.startsWith('cnpg_')
  ) {
    throw new BadRequestException(`${name} is reserved`);
  }
}

export function roleSecretName(cluster: string, name: string): string {
  return `${cluster}-user-${name.replace(/_/g, '-')}`.slice(0, 63);
}

export function managedRole(name: string, access: RoleAccess, secretName: string) {
  return {
    name,
    ensure: 'present',
    login: true,
    inherit: true,
    connectionLimit: 20,
    comment: ROLE_MARKER,
    inRoles: access === 'write' ? ['pg_read_all_data', 'pg_write_all_data'] : ['pg_read_all_data'],
    passwordSecret: { name: secretName }
  };
}

export function managedUserRoles(roles: unknown): any[] {
  return (Array.isArray(roles) ? roles : []).filter((r: any) => r?.comment === ROLE_MARKER);
}

export function roleAccess(role: any): RoleAccess {
  return (role?.inRoles ?? []).includes('pg_write_all_data') ? 'write' : 'read';
}

export function withRole(roles: unknown, role: { name: string }): any[] {
  const list = Array.isArray(roles) ? roles.filter((r: any) => r?.name !== role.name) : [];
  return [...list, role];
}

export interface RestoreRequest {
  backupId?: string;
  checkpointId?: string;
  at?: string;
  mode?: 'in_place' | 'fork';
  name?: string;
  environmentId?: string;
  projectId?: string;
}

export function targetFromRequest(req: RestoreRequest, defaultLatest: boolean): OperationTarget {
  if (req.checkpointId) return { type: 'checkpoint', checkpointId: req.checkpointId };
  if (req.backupId) return { type: 'backup', backupId: req.backupId };
  const at = String(req.at ?? '').trim();
  if (at === 'now') return { type: 'now' };
  if (at === '' || at === 'latest') return defaultLatest ? { type: 'latest' } : { type: 'now' };
  const t = Date.parse(at);
  if (!Number.isFinite(t))
    throw new BadRequestException('at must be "now", "latest" or an ISO timestamp');
  if (t > Date.now()) throw new BadRequestException("at can't be in the future");
  return { type: 'time', time: new Date(t).toISOString() };
}

export interface ForkSide {
  projectId: string;
  organizationId: string;
  canEdit: boolean;
}

export type ForkVerdict =
  | { target: OperationTarget; crossProject: boolean }
  | {
      reason: 'source_forbidden' | 'target_missing' | 'target_forbidden' | 'live_cross_project';
      message: string;
    };

export function forkDecision(
  source: ForkSide,
  target: ForkSide | null,
  req: RestoreRequest
): ForkVerdict {
  if (!source.canEdit) {
    return {
      reason: 'source_forbidden',
      message: "Your role doesn't allow you to copy this database"
    };
  }
  if (!target || target.organizationId !== source.organizationId) {
    return { reason: 'target_missing', message: 'Project not found' };
  }
  if (!target.canEdit) {
    return {
      reason: 'target_forbidden',
      message: "Your role doesn't allow you to add databases to that project"
    };
  }
  const crossProject = target.projectId !== source.projectId;
  const point = targetFromRequest(req, crossProject);
  if (crossProject && point.type === 'now') {
    return {
      reason: 'live_cross_project',
      message:
        "A copy into another project starts from a backup, because projects can't reach each other. Pick the latest backup or a time."
    };
  }
  return { target: point, crossProject };
}

@Injectable()
export class DatabaseRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
    private readonly operations: DatabaseOperationsService,
    private readonly checkpoints: DatabaseCheckpointsService,
    private readonly drills: DatabaseDrillsService,
    private readonly trash: DatabaseTrashService,
    private readonly security: PostgresSecurityService,
    private readonly moduleRef: ModuleRef
  ) {}

  private async databases(): Promise<DatabasesService> {
    const { DatabasesService: Svc } = await import('./databases.service.js');
    return this.moduleRef.get(Svc, { strict: false });
  }

  private async assertRestorable(databaseId: string, target: OperationTarget) {
    if (target.type === 'now' || target.type === 'major') return;
    const backups = await this.prisma.databaseBackup.findMany({
      where: { databaseId },
      select: { barmanId: true, status: true, endLsn: true, completedAt: true, id: true }
    });
    let point: RestorePoint;
    if (target.type === 'backup') {
      point = {
        type: 'backup',
        backup: backups.find((b) => b.id === target.backupId) ?? null
      };
    } else if (target.type === 'checkpoint') {
      const checkpoint = await this.checkpoints.get(target.checkpointId);
      point = {
        type: 'checkpoint',
        checkpoint: checkpoint?.databaseId === databaseId ? checkpoint : null
      };
    } else {
      point = target;
    }
    const blocker = restoreBlocker(point, backups);
    if (blocker) throw new BadRequestException(blocker);
  }

  async restore(databaseId: string, req: RestoreRequest, clerkId: string, userData?: UserData) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    const mode = req.mode === 'fork' ? 'fork' : 'in_place';
    const target = targetFromRequest(req, true);
    if (target.type === 'now' && mode === 'in_place') {
      throw new BadRequestException(
        'Restoring in place to now changes nothing. Pick a time, backup or checkpoint.'
      );
    }
    await this.assertRestorable(database.id, target);
    if (mode === 'in_place') await this.checkpoints.before(database.id, 'a restore', user.id);
    const source = await this.operations.sourceFromDatabase(database.id);
    const op = await this.operations.enqueue({
      kind: 'restore',
      mode,
      databaseId: database.id,
      source,
      target,
      request: { name: req.name, environmentId: req.environmentId },
      requestedBy: user.id
    });
    this.auditOp('database.restore.started', user, database, { operationId: op.id, mode, target });
    return op;
  }

  async fork(databaseId: string, req: RestoreRequest, clerkId: string, userData?: UserData) {
    const {
      user,
      database,
      access: sourceAccess
    } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const sourceSide: ForkSide = {
      projectId: database.projectId,
      organizationId: database.project.organizationId,
      canEdit: sourceAccess.canEdit
    };
    const targetProjectId = String(req.projectId ?? '').trim() || database.projectId;
    const targetSide =
      targetProjectId === database.projectId
        ? sourceSide
        : await this.access
            .assertProjectView(targetProjectId, clerkId, userData)
            .then(({ access }): ForkSide => ({
              projectId: targetProjectId,
              organizationId: access.organizationId,
              canEdit: access.canEdit
            }))
            .catch((e) => {
              if (e instanceof NotFoundException) return null;
              throw e;
            });
    const verdict = forkDecision(sourceSide, targetSide, req);
    if ('reason' in verdict) {
      if (verdict.reason === 'target_missing') throw new NotFoundException(verdict.message);
      if (verdict.reason === 'live_cross_project') throw new BadRequestException(verdict.message);
      throw new ForbiddenException(verdict.message);
    }
    if (req.environmentId) {
      const env = await this.prisma.environment.findUnique({
        where: { id: req.environmentId },
        select: { projectId: true }
      });
      if (!env || env.projectId !== targetProjectId) {
        throw new BadRequestException("Environment doesn't belong to that project");
      }
    }
    await this.assertRestorable(database.id, verdict.target);
    const source = await this.operations.sourceFromDatabase(database.id);
    const op = await this.operations.enqueue({
      kind: 'fork',
      mode: 'fork',
      databaseId: database.id,
      source,
      target: verdict.target,
      request: {
        name: req.name,
        environmentId: req.environmentId,
        ...(verdict.crossProject ? { projectId: targetProjectId } : {})
      },
      requestedBy: user.id
    });
    this.auditOp(
      'database.forked',
      user,
      { ...database, name: source.name },
      {
        operationId: op.id,
        target: verdict.target,
        ...(verdict.crossProject ? { targetProjectId } : {})
      }
    );
    return op;
  }

  async operation(opId: string, clerkId: string, userData?: UserData, wait = false) {
    let op = await this.operations.get(opId);
    if (!op) throw new NotFoundException('Operation not found');
    await this.assertOperationView(op, clerkId, userData);
    const deadline = Date.now() + 25_000;
    while (wait && ['pending', 'running'].includes(op!.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      op = await this.operations.get(opId);
    }
    return op;
  }

  async cancelOperation(opId: string, clerkId: string, userData?: UserData) {
    const op = await this.operations.get(opId);
    if (!op) throw new NotFoundException('Operation not found');
    await this.assertOperationEdit(op, clerkId, userData);
    return this.operations.cancel(opId);
  }

  async undoRestore(opId: string, clerkId: string, userData?: UserData) {
    const op = await this.operations.get(opId);
    if (!op) throw new NotFoundException('Operation not found');
    await this.assertOperationEdit(op, clerkId, userData);
    return this.operations.undoRestore(opId);
  }

  private async assertOperationView(
    op: { databaseId: string | null; source: unknown },
    clerkId: string,
    userData?: UserData
  ) {
    const projectId = (op.source as any)?.projectId as string | undefined;
    if (op.databaseId) {
      const exists = await this.prisma.database.findUnique({
        where: { id: op.databaseId },
        select: { id: true }
      });
      if (exists) {
        await this.access.assertDatabaseView(op.databaseId, clerkId, userData);
        return;
      }
    }
    if (!projectId) throw new NotFoundException('Operation not found');
    await this.access.assertProjectEditAccess(
      projectId,
      clerkId,
      userData,
      'view database operations'
    );
  }

  private async assertOperationEdit(
    op: { databaseId: string | null; source: unknown },
    clerkId: string,
    userData?: UserData
  ) {
    const projectId = (op.source as any)?.projectId as string | undefined;
    if (!projectId) throw new NotFoundException('Operation not found');
    await this.access.assertProjectEditAccess(
      projectId,
      clerkId,
      userData,
      'manage database operations'
    );
  }

  async listOperations(databaseId: string, clerkId: string, userData?: UserData) {
    await this.access.assertDatabaseView(databaseId, clerkId, userData);
    return this.operations.list(databaseId);
  }

  async recoveryWindow(databaseId: string, clerkId: string, userData?: UserData) {
    const { database } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const [backups, checkpoints, drills, active] = await Promise.all([
      this.prisma.databaseBackup.findMany({
        where: { databaseId, status: 'completed' },
        orderBy: { completedAt: 'asc' },
        select: {
          id: true,
          label: true,
          type: true,
          completedAt: true,
          barmanId: true,
          startedAt: true
        }
      }),
      this.checkpoints.list(databaseId, { take: 200 }),
      this.drills.list(databaseId, 5),
      this.prisma.databaseOperation.findMany({
        where: {
          OR: [{ databaseId }, { targetDatabaseId: databaseId }],
          status: { in: ['pending', 'running'] }
        }
      })
    ]);
    const retentionStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const usable = backups.filter(
      (b) => b.completedAt && b.completedAt.getTime() >= retentionStart
    );
    const full = await this.prisma.database.findUnique({
      where: { id: database.id },
      select: {
        clusterStatus: true,
        deletionProtection: true,
        ddlCheckpoints: true,
        restoreTests: true
      }
    });
    const archiving = ((full?.clusterStatus as any)?.conditions ?? []).find(
      (c: any) => c?.type === 'ContinuousArchiving'
    );
    return {
      earliest: usable[0]?.completedAt ?? null,
      latest: archiving?.status === 'True' ? new Date() : (usable.at(-1)?.completedAt ?? null),
      archiving: archiving
        ? { ok: archiving.status === 'True', message: archiving.message ?? null }
        : null,
      backups: usable,
      checkpoints,
      lastRestoreTest: drills[0] ?? null,
      restoreTests: drills,
      activeOperations: active,
      protection: {
        deletionProtection: full?.deletionProtection ?? false,
        ddlCheckpoints: full?.ddlCheckpoints ?? true,
        restoreTests: full?.restoreTests ?? true
      }
    };
  }

  async listCheckpoints(databaseId: string, clerkId: string, userData?: UserData) {
    await this.access.assertDatabaseView(databaseId, clerkId, userData);
    return this.checkpoints.list(databaseId);
  }

  async createCheckpoint(
    databaseId: string,
    label: string | undefined,
    clerkId: string,
    userData?: UserData
  ) {
    const { user } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    const res = await this.checkpoints.create([databaseId], {
      kind: 'manual',
      label,
      createdBy: user.id
    });
    return res.checkpoints[0];
  }

  async createCheckpoints(
    scope: { databaseIds?: string[]; projectId?: string; environmentId?: string; label?: string },
    clerkId: string,
    userData?: UserData
  ) {
    let projectId = scope.projectId;
    if (!projectId && scope.environmentId) {
      const env = await this.prisma.environment.findUnique({ where: { id: scope.environmentId } });
      if (!env) throw new NotFoundException('Environment not found');
      projectId = env.projectId;
    }
    const ids = await this.checkpoints.databaseIdsFor({
      databaseIds: scope.databaseIds,
      projectId,
      environmentId: scope.environmentId
    });
    if (ids.length === 0) throw new BadRequestException('No databases to checkpoint');
    if (ids.length > 100) throw new BadRequestException('At most 100 databases per checkpoint');
    let userId: string | null = null;
    for (const id of ids) {
      const { user } = await this.access.assertDatabaseEditor(id, clerkId, userData);
      userId = user.id;
    }
    return this.checkpoints.create(ids, { kind: 'manual', label: scope.label, createdBy: userId });
  }

  async checkpointGroup(groupId: string, clerkId: string, userData?: UserData) {
    const rows = await this.checkpoints.listGroup(groupId);
    if (rows.length === 0) throw new NotFoundException('Checkpoint group not found');
    for (const id of new Set(rows.map((r) => r.databaseId))) {
      await this.access.assertDatabaseView(id, clerkId, userData).catch(() => {
        throw new NotFoundException('Checkpoint group not found');
      });
    }
    return rows;
  }

  async restoreCheckpoint(
    checkpointId: string,
    req: { mode?: 'in_place' | 'fork'; name?: string; environmentId?: string },
    clerkId: string,
    userData?: UserData
  ) {
    const cp = await this.checkpoints.get(checkpointId);
    if (!cp) throw new NotFoundException('Checkpoint not found');
    return this.restore(cp.databaseId, { ...req, checkpointId }, clerkId, userData);
  }

  async restoreCheckpointGroup(
    groupId: string,
    req: { mode?: 'in_place' | 'fork' },
    clerkId: string,
    userData?: UserData
  ) {
    const rows = await this.checkpoints.listGroup(groupId);
    if (rows.length === 0) throw new NotFoundException('Checkpoint group not found');
    for (const id of new Set(rows.map((r) => r.databaseId))) {
      await this.access.assertDatabaseView(id, clerkId, userData).catch(() => {
        throw new NotFoundException('Checkpoint group not found');
      });
    }
    // Restoring needs edit rights on every database in the group. Refuse the
    // whole request up front (403) instead of returning a per-database refusal
    // list with a 201 to a viewer.
    for (const id of new Set(rows.map((r) => r.databaseId))) {
      await this.access.assertDatabaseEditor(id, clerkId, userData);
    }
    const ops = [];
    for (const cp of rows) {
      ops.push(
        await this.restore(
          cp.databaseId,
          { mode: req.mode, checkpointId: cp.id },
          clerkId,
          userData
        ).catch((e) => ({ databaseId: cp.databaseId, error: e?.message ?? String(e) }))
      );
    }
    return ops;
  }

  async restoreBeforeLastDeploy(deploymentId: string, clerkId: string, userData?: UserData) {
    const bound = await this.prisma.resourceBinding.findMany({
      where: { deploymentId, resourceType: 'database' },
      select: { resourceId: true }
    });
    const results: unknown[] = [];
    for (const b of bound) {
      const cp = await this.prisma.databaseCheckpoint.findFirst({
        where: {
          databaseId: b.resourceId,
          deploymentId,
          kind: 'pre_deploy',
          status: 'durable',
          hiddenAt: null
        },
        orderBy: { createdAt: 'desc' }
      });
      if (!cp) {
        results.push({
          databaseId: b.resourceId,
          skipped: 'No restorable checkpoint from before the last deploy'
        });
        continue;
      }
      results.push(
        await this.restore(b.resourceId, { checkpointId: cp.id }, clerkId, userData).catch((e) => ({
          databaseId: b.resourceId,
          error: e?.message ?? String(e)
        }))
      );
    }
    return results;
  }

  async hideCheckpoint(checkpointId: string, clerkId: string, userData?: UserData) {
    const cp = await this.checkpoints.get(checkpointId);
    if (!cp) throw new NotFoundException('Checkpoint not found');
    await this.access.assertDatabaseEditor(cp.databaseId, clerkId, userData);
    return this.checkpoints.hide(checkpointId);
  }

  async runRestoreTest(databaseId: string, clerkId: string, userData?: UserData) {
    const { user } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    return this.drills.run(databaseId, user.id);
  }

  async listRestoreTests(databaseId: string, clerkId: string, userData?: UserData) {
    await this.access.assertDatabaseView(databaseId, clerkId, userData);
    return this.drills.list(databaseId);
  }

  async updateProtection(
    databaseId: string,
    body: { deletionProtection?: boolean; ddlCheckpoints?: boolean; restoreTests?: boolean },
    clerkId: string,
    userData?: UserData
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    const data: Prisma.DatabaseUpdateInput = {};
    if (typeof body.deletionProtection === 'boolean')
      data.deletionProtection = body.deletionProtection;
    if (typeof body.ddlCheckpoints === 'boolean') data.ddlCheckpoints = body.ddlCheckpoints;
    if (typeof body.restoreTests === 'boolean') data.restoreTests = body.restoreTests;
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to change');
    const updated = await this.prisma.database.update({
      where: { id: database.id },
      data,
      select: { id: true, deletionProtection: true, ddlCheckpoints: true, restoreTests: true }
    });
    this.auditOp('database.protection.updated', user, database, data as Record<string, unknown>);
    return updated;
  }

  async setPooler(
    databaseId: string,
    body: Partial<PoolerConfig> & { enabled?: boolean },
    clerkId: string,
    userData?: UserData
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('A connection pooler needs a dedicated database');
    }
    const enabled = body.enabled ?? database.poolerEnabled;
    const config = normalizePoolerConfig({ ...((database.poolerConfig as object) ?? {}), ...body });
    if (enabled) {
      await this.k8sCnpg.upsertPooler(
        database.namespace,
        poolerBody(database.namespace, database.clusterName, config, {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': database.clusterName
        })
      );
    } else {
      await this.k8sCnpg.deletePooler(database.namespace, poolerName(database.clusterName));
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { poolerEnabled: enabled, poolerConfig: config as unknown as Prisma.InputJsonValue }
    });
    this.auditOp('database.pooler.updated', user, database, { enabled, ...config });
    return this.poolerState(database.id);
  }

  async poolerState(databaseId: string) {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db?.namespace || !db.clusterName) throw new NotFoundException('Database not found');
    const name = poolerName(db.clusterName);
    const live = db.poolerEnabled
      ? await this.k8sCnpg.getPooler(db.namespace, name).catch(() => null)
      : null;
    return {
      enabled: db.poolerEnabled,
      config: normalizePoolerConfig((db.poolerConfig as Partial<PoolerConfig>) ?? DEFAULT_POOLER),
      host: db.poolerEnabled ? `${name}.${db.namespace}.svc.cluster.local` : null,
      port: 5432,
      ready: Boolean(live?.status?.instances ?? live?.status?.phase === 'active'),
      phase: live?.status?.phase ?? null
    };
  }

  async getPooler(databaseId: string, clerkId: string, userData?: UserData) {
    await this.access.assertDatabaseView(databaseId, clerkId, userData);
    return this.poolerState(databaseId);
  }

  versions() {
    return this.security.offeredVersions();
  }

  async securityReport(databaseId: string, clerkId: string, userData?: UserData) {
    const { database } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const db = await this.prisma.database.findUnique({ where: { id: database.id } });
    if (!db?.namespace || !db.clusterName) throw new NotFoundException('Database not found');
    const cluster = await this.k8sCnpg.readCluster(db.namespace, db.clusterName);
    let version = versionFromImage(cluster?.status?.image ?? cluster?.spec?.imageName);
    if (!version || version.minor === null) {
      const out = await this.k8sCnpg
        .runPsqlInCnpg(db.namespace, db.clusterName, 'postgres', 'SHOW server_version_num;', {
          tuplesOnly: true
        })
        .catch(() => null);
      version = (out?.success ? versionFromServerVersionNum(out.stdout) : null) ?? version;
    }
    const cache = await this.security.load();
    const offered = await this.security.offeredVersions();
    const report = version
      ? securityReport(version, cache?.advisories ?? [], cache?.releases ?? [])
      : null;
    const sameMajor = offered.versions.find((v) => v.major === version?.major) ?? null;
    return {
      ...(report ?? { running: null, vulnerabilities: [], action: 'unknown' }),
      image: cluster?.status?.image ?? cluster?.spec?.imageName ?? null,
      minorUpdate:
        sameMajor &&
        sameMajor.minor !== null &&
        version?.minor !== null &&
        sameMajor.minor > (version?.minor ?? 0)
          ? { to: `${sameMajor.major}.${sameMajor.minor}`, automatic: true }
          : null,
      upgrades: offered.versions.filter((v) => version && v.major > version.major),
      advisoriesFetchedAt: cache?.fetchedAt ?? null
    };
  }

  async upgrade(
    databaseId: string,
    body: { major?: number; rehearse?: boolean },
    clerkId: string,
    userData?: UserData
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Upgrades need a dedicated database');
    }
    if ((database.replicas ?? 1) < 1 || database.status !== 'ready') {
      throw new BadRequestException('The database has to be running and healthy to upgrade');
    }
    const offered = await this.security.offeredVersions();
    const major = Number(body.major);
    const target = offered.versions.find((v) => v.major === major);
    const current = database.pgMajor ?? 17;
    if (!target) {
      throw new BadRequestException(
        `Postgres ${body.major} isn't offered; choose one of ${offered.versions.map((v) => v.major).join(', ')}`
      );
    }
    if (major <= current)
      throw new BadRequestException(`The database already runs Postgres ${current}`);
    const busy = await this.prisma.databaseOperation.findFirst({
      where: {
        databaseId: database.id,
        status: { in: ['pending', 'running'] },
        kind: { in: ['restore', 'upgrade'] }
      },
      select: { id: true }
    });
    if (busy)
      throw new BadRequestException('Another restore or upgrade is running for this database');
    const source = await this.operations.sourceFromDatabase(database.id);
    const op = await this.operations.enqueue({
      kind: 'upgrade',
      databaseId: database.id,
      source,
      target: { type: 'major', major, image: target.image },
      request: { rehearse: body.rehearse !== false },
      requestedBy: user.id
    });
    this.auditOp('database.upgrade.started', user, database, {
      from: current,
      to: major,
      operationId: op.id
    });
    return op;
  }

  async replication(databaseId: string, clerkId: string, userData?: UserData) {
    const { database } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const db = await this.prisma.database.findUnique({ where: { id: database.id } });
    if (!db?.namespace || !db.clusterName) throw new NotFoundException('Database not found');
    const cluster = await this.k8sCnpg.readCluster(db.namespace, db.clusterName);
    return {
      mode: replicationModeOf(cluster?.spec?.postgresql?.synchronous),
      instances: Number(cluster?.spec?.instances ?? db.replicas ?? 1),
      syncStandbys: cluster?.status?.synchronousReplicas ?? null
    };
  }

  async setReplication(
    databaseId: string,
    mode: ReplicationMode,
    clerkId: string,
    userData?: UserData
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (!REPLICATION_MODES.includes(mode))
      throw new BadRequestException('mode must be async, preferred or required');
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Replication needs a dedicated database');
    }
    if (mode !== 'async' && (database.replicas ?? 1) < 2) {
      throw new BadRequestException(
        'Synchronous replication needs at least 2 instances. Add a standby first.'
      );
    }
    await this.k8sCnpg.patchCluster(database.namespace, database.clusterName, {
      spec: { postgresql: { synchronous: synchronousSpec(mode) } }
    });
    this.auditOp('database.replication.updated', user, database, { mode });
    return this.replication(databaseId, clerkId, userData);
  }

  async listRoles(databaseId: string, clerkId: string, userData?: UserData) {
    const { database } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const db = await this.prisma.database.findUnique({ where: { id: database.id } });
    if (!db?.namespace || !db.clusterName) throw new NotFoundException('Database not found');
    const cluster = await this.k8sCnpg.readCluster(db.namespace, db.clusterName);
    return managedUserRoles(cluster?.spec?.managed?.roles).map((r) => ({
      name: r.name,
      access: roleAccess(r),
      present: r.ensure !== 'absent'
    }));
  }

  async createRole(
    databaseId: string,
    body: { name?: string; access?: RoleAccess },
    clerkId: string,
    userData?: UserData
  ) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Users need a dedicated database');
    }
    const name = String(body.name ?? '')
      .trim()
      .toLowerCase();
    const access: RoleAccess = body.access === 'write' ? 'write' : 'read';
    assertRoleName(name, database.dbUser);
    const dbs = await this.databases();
    const password = dbs.generatePassword();
    const secretName = roleSecretName(database.clusterName, name);
    await this.k8sCnpg.writeSecret(
      database.namespace,
      secretName,
      { username: name, password },
      'kubernetes.io/basic-auth'
    );
    const cluster = await this.k8sCnpg.readCluster(database.namespace, database.clusterName);
    const roles = withRole(cluster?.spec?.managed?.roles, managedRole(name, access, secretName));
    await this.k8sCnpg.patchCluster(database.namespace, database.clusterName, {
      spec: { managed: { roles } }
    });
    this.auditOp('database.role.created', user, database, { role: name, access });
    return {
      name,
      access,
      password,
      connectionString: `postgresql://${name}:${encodeURIComponent(password)}@${database.host}:${database.port}/${database.dbName}`
    };
  }

  async deleteRole(databaseId: string, name: string, clerkId: string, userData?: UserData) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (!database.namespace || !database.clusterName)
      throw new NotFoundException('Database not found');
    const cluster = await this.k8sCnpg.readCluster(database.namespace, database.clusterName);
    const current: any[] = cluster?.spec?.managed?.roles ?? [];
    if (!managedUserRoles(current).some((r) => r.name === name))
      throw new NotFoundException('No such user');
    const roles = current.map((r: any) => (r?.name === name ? { ...r, ensure: 'absent' } : r));
    await this.k8sCnpg.patchCluster(database.namespace, database.clusterName, {
      spec: { managed: { roles } }
    });
    this.auditOp('database.role.deleted', user, database, { role: name });
    return { name, present: false };
  }

  async activity(databaseId: string, clerkId: string, userData?: UserData) {
    const { database } = await this.access.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Activity needs a dedicated database');
    }
    const out = await this.k8sCnpg.runPsqlInCnpg(
      database.namespace,
      database.clusterName,
      database.dbName,
      ACTIVITY_SQL,
      { tuplesOnly: true }
    );
    if (!out.success) throw new BadRequestException("The database didn't answer");
    const line = out.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    return line ? JSON.parse(line) : { sessions: [], blocked: [], maxConnections: null };
  }

  async diagnose(databaseId: string, clerkId: string, userData?: UserData) {
    const { access } = await this.access.assertDatabaseView(databaseId, clerkId, userData);
    const dbs = await this.databases();
    const live: any = await dbs.getDatabaseLive(databaseId);
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db) throw new NotFoundException('Database not found');
    const security = await this.securityReport(databaseId, clerkId, userData).catch(() => null);
    const [window, operations, logTail, pooler] = await Promise.all([
      this.recoveryWindow(databaseId, clerkId, userData),
      this.operations.list(databaseId, undefined, 5),
      access.canEdit && db.namespace && db.clusterName
        ? this.k8sCnpg
            .primaryLogTail(db.namespace, db.clusterName, 60)
            .catch((e) => `logs unavailable: ${k8sErrorMessage(e)}`)
        : Promise.resolve(''),
      db.poolerEnabled ? this.poolerState(databaseId) : Promise.resolve(null)
    ]);
    const ls = live?.liveStatus ?? {};
    return {
      database: {
        id: db.id,
        name: db.name,
        status: db.status,
        pgMajor: db.pgMajor,
        storageSize: db.storageSize
      },
      verdict: ls.verdict ?? 'unknown',
      reasons: ls.verdictReasons ?? [],
      instances: {
        ready: ls.readyReplicas ?? 0,
        wanted: ls.replicas ?? db.replicas ?? 1,
        primary: ls.currentPrimary ?? null
      },
      lastRestart: ls.lastTerminationReason
        ? {
            reason: ls.lastTerminationReason,
            exitCode: ls.lastTerminationExitCode ?? null,
            at: ls.lastTerminationAt ?? null,
            restarts: ls.restartCount ?? 0
          }
        : null,
      storage: {
        volume: ls.volume ?? null,
        writeGuard: ls.writeGuard ?? false,
        walPendingSegments: ls.walPendingSegments ?? null
      },
      backups: {
        archiving: window.archiving,
        recoverableFrom: window.earliest,
        recoverableTo: window.latest,
        lastBackupAt: window.backups.at(-1)?.completedAt ?? null,
        method: db.backupMethod ?? 'barman',
        lastRestoreTest: window.lastRestoreTest
          ? {
              status: window.lastRestoreTest.status,
              at: window.lastRestoreTest.finishedAt ?? window.lastRestoreTest.createdAt,
              recoveryMs: (window.lastRestoreTest.result as any)?.recoveryMs ?? null,
              error: window.lastRestoreTest.error
            }
          : null
      },
      checkpoints: window.checkpoints.slice(0, 10),
      protection: window.protection,
      pooler,
      security: security
        ? {
            running: security.running,
            action: security.action,
            vulnerabilities: security.vulnerabilities.length,
            highestScore: (security as any).highestScore ?? null,
            supported: (security as any).supported ?? null,
            eolDate: (security as any).eolDate ?? null,
            minorUpdate: security.minorUpdate
          }
        : null,
      operations,
      logTail: String(logTail).split('\n').slice(-60).join('\n')
    };
  }

  async listDeleted(
    where: { projectId?: string; organizationId?: string },
    clerkId: string,
    userData?: UserData
  ) {
    if (where.projectId) {
      await this.access.assertProjectEditAccess(
        where.projectId,
        clerkId,
        userData,
        'view deleted databases'
      );
      return this.trash.list({ projectId: where.projectId });
    }
    throw new BadRequestException('projectId is required');
  }

  async undelete(
    trashId: string,
    body: { name?: string; environmentId?: string },
    clerkId: string,
    userData?: UserData
  ) {
    const row = await this.trash.get(trashId);
    const { user } = await this.access.assertProjectEditAccess(
      row.projectId,
      clerkId,
      userData,
      'restore deleted databases'
    );
    const op = await this.trash.undelete(trashId, body, user.id);
    void this.audit.log({
      action: 'database.undeleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: row.organizationId,
      projectId: row.projectId,
      targetType: 'database',
      targetId: row.id,
      targetLabel: row.name,
      metadata: { operationId: op.id }
    });
    return op;
  }

  private auditOp(
    action: string,
    user: { id: string; email: string },
    database: any,
    metadata: Record<string, unknown>
  ) {
    void this.audit.log({
      action,
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project?.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: flatMetadata(metadata)
    });
  }
}

function flatMetadata(input: Record<string, unknown>): Record<string, AuditMetadataValue> {
  const out: Record<string, AuditMetadataValue> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v as AuditMetadataValue;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}
