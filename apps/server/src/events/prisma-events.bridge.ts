import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrgEventsService, OrgEventType } from './org-events.service';

/**
 * Bridges Prisma write operations into OrgEvents (for SSE) and invalidates the
 * membership cache. Uses $extends (Prisma 5+/6+) and rebinds the per-model
 * accessors on PrismaService so every existing call site flows through the hook
 * with no caller changes.
 */
const WATCHED_MODELS = [
  'deployment',
  'database',
  'databaseBackup',
  'imageHistory',
  'buildRun',
  'project',
  'ingress',
  'organizationMember',
  'projectMember'
] as const;

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany'
]);

@Injectable()
export class PrismaEventsBridge implements OnModuleInit {
  private readonly logger = new Logger(PrismaEventsBridge.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly membershipCache: MembershipCacheService,
    private readonly notifications: NotificationsService
  ) {}

  onModuleInit() {
    this.membershipCache.onRevoked((organizationId, userId) =>
      this.orgEvents.emit({ organizationId, type: 'membership.changed', id: userId })
    );
    const extended = this.prisma.$extends({
      query: {
        $allModels: {
          $allOperations: async ({ args, model, operation, query }) => {
            const result = await query(args);
            if (WRITE_OPS.has(operation)) {
              this.handle({ model, action: operation, args }, result).catch((err) =>
                this.logger.warn(
                  `event bridge failed for ${model}.${operation}: ${err?.message ?? err}`
                )
              );
            }
            return result;
          }
        }
      }
    });

    // Replace per-model accessors on the original PrismaService instance so that
    // existing `this.prisma.deployment.update(...)` calls flow through the hook.
    for (const m of WATCHED_MODELS) {
      const value = (extended as any)[m];
      if (!value) continue;
      Object.defineProperty(this.prisma, m, {
        value,
        configurable: true,
        writable: true
      });
    }
  }

  private async handle(params: { model?: string; action: string; args: any }, result: any) {
    if (!params.model) return;
    if (!WRITE_OPS.has(params.action)) return;

    switch (params.model) {
      case 'Deployment':
        return this.emitForDeployment(params, result);
      case 'Database':
        return this.emitForDatabase(params, result);
      case 'DatabaseBackup':
        return this.emitForDatabaseBackup(params, result);
      case 'ImageHistory':
        return this.emitForImageHistory(params, result);
      case 'BuildRun':
        return this.emitForBuildRun(params, result);
      case 'Project':
        return this.emitForProject(params, result);
      case 'Ingress':
        return this.emitForIngress(params, result);
      case 'OrganizationMember':
        return this.emitForMembership(params, result);
      case 'ProjectMember':
        return this.emitForProjectMembership(params, result);
      default:
        return undefined;
    }
  }

  private async resolveOrgIdFromDeployment(
    deploymentId?: string
  ): Promise<{ orgId: string; projectId: string } | null> {
    if (!deploymentId) return null;
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true, project: { select: { organizationId: true } } }
    });
    if (!dep) return null;
    return { orgId: dep.project.organizationId, projectId: dep.projectId };
  }

  private async resolveOrgIdFromProject(projectId?: string): Promise<string | null> {
    if (!projectId) return null;
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });
    return p?.organizationId ?? null;
  }

  private idFromArgs(params: any, result: any): string | undefined {
    return result?.id ?? params?.args?.where?.id ?? params?.args?.data?.id;
  }

  private async emitForDeployment(params: any, result: any) {
    const id = this.idFromArgs(params, result);
    const ctx = id ? await this.resolveOrgIdFromDeployment(id) : null;
    if (!ctx) return;
    const data = params?.args?.data ?? {};
    const isBuild = 'buildStatus' in data || 'buildStep' in data;
    const type: OrgEventType = isBuild ? 'build.changed' : 'deployment.changed';
    const buildStatus =
      typeof data.buildStatus === 'string' ? data.buildStatus : data.buildStatus?.set;
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type,
      id,
      projectId: ctx.projectId,
      ...(isBuild && typeof buildStatus === 'string' ? { payload: { buildStatus } } : {})
    });

    if (buildStatus === 'succeeded' || buildStatus === 'failed') {
      this.notifications
        .notifyDeploy(id!, buildStatus)
        .catch((err) =>
          this.logger.warn(`deploy notification failed for ${id}: ${err?.message ?? err}`)
        );
    }
  }

  private async emitForDatabase(params: any, result: any) {
    const id = this.idFromArgs(params, result);
    if (!id) return;
    const db = await this.prisma.database.findUnique({
      where: { id },
      select: { projectId: true, project: { select: { organizationId: true } } }
    });
    if (!db) return;
    this.orgEvents.emit({
      organizationId: db.project.organizationId,
      type: 'database.changed',
      id,
      projectId: db.projectId
    });
  }

  private async emitForDatabaseBackup(params: any, result: any) {
    const databaseId =
      result?.databaseId ?? params?.args?.data?.databaseId ?? params?.args?.where?.databaseId;
    if (!databaseId) return;
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: { projectId: true, project: { select: { organizationId: true } } }
    });
    if (!db) return;
    this.orgEvents.emit({
      organizationId: db.project.organizationId,
      type: 'database.changed',
      id: databaseId,
      projectId: db.projectId
    });
  }

  private async emitForImageHistory(params: any, result: any) {
    const deploymentId = result?.deploymentId ?? params?.args?.data?.deploymentId;
    const ctx = await this.resolveOrgIdFromDeployment(deploymentId);
    if (!ctx) return;
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'build.changed',
      id: deploymentId,
      projectId: ctx.projectId
    });
  }

  private async emitForBuildRun(params: any, result: any) {
    // deploymentId can come from the returned row, the create payload, or a
    // where-clause (coalesce updateMany filters by deploymentId). A claim
    // (update by id) has none of those, so fall back to looking the run up.
    let deploymentId =
      result?.deploymentId ?? params?.args?.data?.deploymentId ?? params?.args?.where?.deploymentId;
    if (!deploymentId) {
      const id = result?.id ?? params?.args?.where?.id;
      if (id) {
        const br = await this.prisma.buildRun.findUnique({
          where: { id },
          select: { deploymentId: true }
        });
        deploymentId = br?.deploymentId;
      }
    }
    const ctx = await this.resolveOrgIdFromDeployment(deploymentId);
    if (!ctx) return;
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'build.changed',
      id: deploymentId,
      projectId: ctx.projectId
    });
  }

  private async emitForProject(params: any, result: any) {
    const id = this.idFromArgs(params, result);
    const orgId = result?.organizationId ?? (id ? await this.resolveOrgIdFromProject(id) : null);
    if (!orgId) return;
    this.orgEvents.emit({ organizationId: orgId, type: 'project.changed', id });
  }

  private async emitForIngress(params: any, result: any) {
    const deploymentId = result?.deploymentId ?? params?.args?.data?.deploymentId;
    const ctx = await this.resolveOrgIdFromDeployment(deploymentId);
    if (!ctx) return;
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'deployment.changed',
      id: deploymentId,
      projectId: ctx.projectId
    });
  }

  private async emitForProjectMembership(params: any, result: any) {
    const userId = result?.userId ?? params?.args?.where?.userId ?? params?.args?.data?.userId;
    const projectId =
      result?.projectId ?? params?.args?.where?.projectId ?? params?.args?.data?.projectId;
    if (!userId || !projectId) return;
    const orgId = await this.resolveOrgIdFromProject(projectId);
    if (!orgId) return;
    this.orgEvents.emit({ organizationId: orgId, type: 'membership.changed', id: userId });
  }

  private async emitForMembership(params: any, result: any) {
    // Invalidate membership cache for affected user(s)
    const userId = result?.userId ?? params?.args?.where?.userId ?? params?.args?.data?.userId;
    const orgId =
      result?.organizationId ??
      params?.args?.where?.organizationId ??
      params?.args?.data?.organizationId;
    // `userId` here is the internal UUID (OrganizationMember.userId FK), but cache
    // keys can be the JWT sub (= HackClub ID for OAuth users). Use the internal-id
    // walker so HackClub-ID-keyed entries get dropped too.
    if (userId) this.membershipCache.invalidateInternalUserId(userId);
    else if (orgId) this.membershipCache.invalidateOrg(orgId);
    else this.membershipCache.invalidateAll();
    if (orgId)
      this.orgEvents.emit({ organizationId: orgId, type: 'membership.changed', id: userId });
  }
}
