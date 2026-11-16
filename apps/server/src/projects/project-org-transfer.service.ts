import { RegistryCredentialsService } from './registry-credentials.service';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { QuotasService } from '../quotas/quotas.service';
import { UsersService } from '../users/users.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { DatabasesService } from './databases.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { AuditService } from '../audit/audit.service';
import { formatSlug } from './projects.utils';

type UserData = {
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
};

type OrgWithR2 = {
  id: string;
  name: string;
  slug: string;
  cpuLimitMilli: number | null;
  memoryLimitBytes: bigint | null;
  backupR2Endpoint: string | null;
  backupR2Bucket: string | null;
  backupR2AccessKey: string | null;
  backupR2SecretKey: string | null;
};

/**
 * Move a Project from one Organization to another. Almost everything a project
 * owns FKs to `projectId`, not `organizationId`, so the move is fundamentally
 * "flip `Project.organizationId` and re-parent the subtree in one write". This
 * service handles the friction the flip alone doesn't: slug collisions, access
 * eviction, owner re-assignment, project-scoped notifications, the k8s
 * namespace tag, quota re-application, and relocating the databases' backups.
 */
@Injectable()
export class ProjectOrgTransferService {
  private readonly logger = new Logger(ProjectOrgTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotas: QuotasService,
    private readonly usersService: UsersService,
    private readonly k8sNamespace: K8sNamespaceService,
    private readonly databases: DatabasesService,
    private readonly membershipCache: MembershipCacheService,
    private readonly audit: AuditService,
    private readonly registryCredentials: RegistryCredentialsService
  ) {}

  /** Authorize the move and load the project + destination org. */
  private async resolve(
    projectId: string,
    destinationOrgId: string,
    clerkId: string,
    userData?: UserData
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: { omit: { backupR2AccessKey: false, backupR2SecretKey: false } },
        members: { include: { user: { select: { id: true, username: true } } } }
      }
    });
    if (!project) throw new NotFoundException('Project not found');

    // Source: moving a project takes it away from the org, so it's the org's
    // call. Destination: you must be able to create projects there (member, not
    // guest): the same gate as spawning a brand-new project in that org.
    await this.authz.requireProjectView(project.id, user.id);
    await this.authz.requireOrgAdmin(project.organizationId, user.id);
    // Input checks come after the access check so a project the caller cannot
    // see answers like one that does not exist.
    if (!destinationOrgId) {
      throw new BadRequestException('destinationOrgId is required');
    }
    if (destinationOrgId === project.organizationId) {
      throw new BadRequestException('The project is already in this organization');
    }
    await this.authz.requireOrgCanCreateProjects(destinationOrgId, user.id);

    const destOrg = (await this.prisma.organization.findUnique({
      where: { id: destinationOrgId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    })) as OrgWithR2 | null;
    if (!destOrg) throw new NotFoundException('Destination organization not found');

    return { user, project, destOrg };
  }

  /** Everything the move will do, computed once and shared by preview + commit. */
  private async computePlan(
    project: Awaited<ReturnType<ProjectOrgTransferService['resolve']>>['project'],
    destOrg: OrgWithR2,
    requestedSlug?: string
  ) {
    const desiredSlug = formatSlug((requestedSlug ?? '').trim() || project.slug);
    if (!desiredSlug) throw new BadRequestException("Project slug can't be empty");

    const slugTaken = await this.prisma.project.findUnique({
      where: { organizationId_slug: { organizationId: destOrg.id, slug: desiredSlug } }
    });
    const slugCollision = Boolean(slugTaken && slugTaken.id !== project.id);

    // Access: a ProjectMember grants nothing without an OrganizationMember in
    // the same org, so anyone not already in the destination org is evicted.
    const memberUserIds = project.members.map((m) => m.userId);
    const destMembers = memberUserIds.length
      ? await this.prisma.organizationMember.findMany({
          where: { organizationId: destOrg.id, userId: { in: memberUserIds }, status: 'active' },
          select: { userId: true }
        })
      : [];
    const destMemberSet = new Set(destMembers.map((m) => m.userId));
    const membersLosingAccess = project.members
      .filter((m) => !destMemberSet.has(m.userId))
      .map((m) => ({ id: m.user.id, username: m.user.username }));
    const membersKept = memberUserIds.length - membersLosingAccess.length;
    const ownerInDest = project.ownerId ? destMemberSet.has(project.ownerId) : false;

    // Quota: warn (never block) if the project's requests would push the
    // destination org past a hard cap.
    let quota: {
      willExceed: boolean;
      requestedCpuMilli: number;
      requestedMemoryBytes: number;
      usedCpuMilli: number;
      usedMemoryBytes: number;
      capCpuMilli: number | null;
      capMemoryBytes: number | null;
    } | null = null;
    if (destOrg.cpuLimitMilli != null || destOrg.memoryLimitBytes != null) {
      const [deployments, dbs, orgQuota] = await Promise.all([
        this.prisma.deployment.findMany({
          where: { projectId: project.id },
          select: { cpuRequestMilli: true, memoryRequestBytes: true, replicas: true }
        }),
        this.prisma.database.findMany({
          where: { projectId: project.id },
          select: { cpuRequestMilli: true, memoryRequestBytes: true, replicas: true }
        }),
        this.quotas.getOrgUsageWithCaps(destOrg.id)
      ]);
      let requestedCpuMilli = 0;
      let requestedMemoryBytes = 0;
      for (const r of [...deployments, ...dbs]) {
        const replicas = r.replicas ?? 1;
        requestedCpuMilli += (r.cpuRequestMilli ?? 0) * replicas;
        requestedMemoryBytes += Number(r.memoryRequestBytes ?? 0) * replicas;
      }
      const capCpuMilli = orgQuota.org.cpuLimitMilli;
      const capMemoryBytes = orgQuota.org.memoryLimitBytes;
      const willExceed =
        (capCpuMilli != null && orgQuota.usage.cpuMilli + requestedCpuMilli > capCpuMilli) ||
        (capMemoryBytes != null &&
          orgQuota.usage.memoryBytes + requestedMemoryBytes > capMemoryBytes);
      quota = {
        willExceed,
        requestedCpuMilli,
        requestedMemoryBytes,
        usedCpuMilli: orgQuota.usage.cpuMilli,
        usedMemoryBytes: orgQuota.usage.memoryBytes,
        capCpuMilli,
        capMemoryBytes
      };
    }

    // Backups: the database re-points at the destination's storage. Existing
    // backups stay where they were taken (still restorable); only the archive
    // target moves. If the destination has no R2, new backups pause.
    const databaseCount = await this.prisma.database.count({ where: { projectId: project.id } });
    const sourceHasR2 = this.databases.hasBackupStorage(project.organization);
    const destHasR2 = this.databases.hasBackupStorage(destOrg);
    const backups = {
      databaseCount,
      willContinue: databaseCount > 0 && destHasR2,
      // The scary-warning case: backups were running but the destination has no
      // storage, so new backups stop until it is configured.
      willPause: databaseCount > 0 && sourceHasR2 && !destHasR2
    };

    return {
      desiredSlug,
      slugCollision,
      membersLosingAccess,
      membersKept,
      ownerInDest,
      quota,
      backups
    };
  }

  async preview(
    projectId: string,
    destinationOrgId: string,
    requestedSlug: string | undefined,
    clerkId: string,
    userData?: UserData
  ) {
    const { project, destOrg } = await this.resolve(projectId, destinationOrgId, clerkId, userData);
    const plan = await this.computePlan(project, destOrg, requestedSlug);
    return {
      project: { id: project.id, name: project.name, slug: project.slug },
      sourceOrg: {
        id: project.organization.id,
        name: project.organization.name,
        slug: project.organization.slug
      },
      destinationOrg: { id: destOrg.id, name: destOrg.name, slug: destOrg.slug },
      proposedSlug: plan.desiredSlug,
      slugCollision: plan.slugCollision,
      membersLosingAccess: plan.membersLosingAccess,
      membersKept: plan.membersKept,
      ownerReassignedToMover: !plan.ownerInDest,
      quota: plan.quota,
      backups: plan.backups
    };
  }

  async transfer(
    projectId: string,
    destinationOrgId: string,
    requestedSlug: string | undefined,
    clerkId: string,
    userData?: UserData
  ) {
    const { user, project, destOrg } = await this.resolve(
      projectId,
      destinationOrgId,
      clerkId,
      userData
    );
    const plan = await this.computePlan(project, destOrg, requestedSlug);

    if (plan.slugCollision) {
      throw new BadRequestException(
        'A project with this name already exists in the destination organization. Pick a different name.'
      );
    }

    if (plan.quota?.willExceed) {
      const destAccess = await this.authz.getOrgAccess(destOrg.id, user.id);
      if (!destAccess?.isAdmin) {
        throw new ForbiddenException(
          "This project would push the destination organization past its limits. Ask one of that organization's admins to move it."
        );
      }
    }

    const sourceOrgId = project.organizationId;
    const losingIds = plan.membersLosingAccess.map((m) => m.id);
    const reassignOwner = !plan.ownerInDest;

    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          organizationId: destOrg.id,
          slug: plan.desiredSlug,
          ...(reassignOwner ? { ownerId: user.id } : {})
        }
      });
      if (losingIds.length) {
        await tx.projectMember.deleteMany({
          where: { projectId: project.id, userId: { in: losingIds } }
        });
      }
      // Pending project invitations were issued in the source-org context and
      // would grant access to the wrong org.
      await tx.projectInvitation.deleteMany({ where: { projectId: project.id } });
      // Re-point project-scoped notification channels/rules; org-scoped ones
      // stay behind with the source org by design.
      await tx.notificationChannel.updateMany({
        where: { organizationId: sourceOrgId, scopeType: 'project', scopeId: project.id },
        data: { organizationId: destOrg.id }
      });
      await tx.notificationRule.updateMany({
        where: { organizationId: sourceOrgId, scopeType: 'project', scopeId: project.id },
        data: { organizationId: destOrg.id }
      });
    });

    // The mover must not lock themselves out of the project they just moved.
    // Guarantee an explicit admin membership; promote if they carried a lesser
    // role and now own it.
    const adminRole = await this.prisma.role.findFirst({ where: { name: 'admin' } });
    if (adminRole) {
      const existing = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: user.id } }
      });
      if (!existing) {
        await this.prisma.projectMember.create({
          data: { projectId: project.id, userId: user.id, roleId: adminRole.id, addedBy: user.id }
        });
      } else if (reassignOwner && existing.roleId !== adminRole.id) {
        await this.prisma.projectMember.update({
          where: { id: existing.id },
          data: { roleId: adminRole.id }
        });
      }
    }

    // Every environment has its own namespace (the production env shares the
    // project namespace; others are `{org}-{project}-{env}`). k8s names are
    // immutable, so tag them all so the whole project is still findable under
    // the new org (`kubectl get ns -l orchard.my/current-org=<slug>`).
    const envs = await this.prisma.environment.findMany({
      where: { projectId: project.id },
      select: { namespace: true }
    });
    const namespaces = new Set<string>([project.namespace, ...envs.map((e) => e.namespace)]);
    for (const ns of namespaces) {
      await this.k8sNamespace
        .tagNamespaceMoved(ns, {
          fromOrgSlug: project.organization.slug,
          toOrgSlug: destOrg.slug,
          movedBy: user.email || user.id
        })
        .catch((e) => this.logger.error(`Failed to tag namespace ${ns}: ${e?.message ?? e}`));
    }

    // Membership caches key on org; drop both so evicted/gained access resolves.
    this.membershipCache.invalidateOrg(sourceOrgId);
    this.membershipCache.invalidateOrg(destOrg.id);
    for (const id of losingIds) this.membershipCache.revoked(sourceOrgId, id);

    await this.registryCredentials
      .syncProject(project.id)
      .catch((e) =>
        this.logger.error(`Registry credential sync failed for ${project.id}: ${e?.message ?? e}`)
      );

    // Re-push every environment namespace's quotas under the destination's caps.
    await this.quotas
      .applyProjectQuota(project.id)
      .catch((e) => this.logger.error(`applyProjectQuota failed: ${e?.message ?? e}`));

    // Re-point the databases' backups at the destination's storage (or pause
    // them if it has none). Existing backups are never touched.
    if (plan.backups.databaseCount > 0) {
      void this.databases
        .repointProjectBackupsToOrg(project.id, destOrg.id)
        .catch((e) =>
          this.logger.error(`Backup re-point failed for project ${project.id}: ${e?.message ?? e}`)
        );
    }

    void this.audit.log({
      action: 'project.organization.transferred',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: destOrg.id,
      projectId: project.id,
      targetType: 'project',
      targetId: project.id,
      targetLabel: project.name,
      metadata: {
        fromOrganizationId: sourceOrgId,
        toOrganizationId: destOrg.id,
        slug: [project.slug, plan.desiredSlug],
        membersEvicted: losingIds.length,
        ownerReassigned: reassignOwner,
        backupsRepointed: plan.backups.willContinue,
        backupsPaused: plan.backups.willPause
      }
    });
    void this.audit.log({
      action: 'project.organization.transferred',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: sourceOrgId,
      projectId: project.id,
      targetType: 'project',
      targetId: project.id,
      targetLabel: project.name,
      metadata: {
        fromOrganizationId: sourceOrgId,
        toOrganizationId: destOrg.id,
        slug: [project.slug, plan.desiredSlug],
        membersEvicted: losingIds.length,
        ownerReassigned: reassignOwner,
        backupsRepointed: plan.backups.willContinue,
        backupsPaused: plan.backups.willPause
      }
    });

    return {
      id: project.id,
      slug: plan.desiredSlug,
      organizationId: destOrg.id,
      destinationOrgSlug: destOrg.slug
    };
  }
}
