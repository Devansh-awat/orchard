import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationRole } from '@prisma/client';

export type ProjectRoleName = 'admin' | 'member' | 'viewer';

export interface OrgAccess {
  organizationId: string;
  role: OrganizationRole;
  isAdmin: boolean;
}

export interface ProjectAccess {
  projectId: string;
  organizationId: string;
  source: 'orgAdmin' | 'projectMember' | 'superadmin';
  orgRole: OrganizationRole | null;
  projectRoleName: ProjectRoleName | null;
  canView: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canDelete: boolean;
}

/**
 * Centralised RBAC for organizations and projects.
 *
 * Org roles: owner / admin / member.
 *   - Non-members must not see anything about the org.
 *   - Owners and admins can see/edit org settings AND every project in the org.
 *   - Plain members can only see/use projects they have been explicitly added to.
 *
 * Project roles: admin / member / viewer.
 *   - admin: full project control including delete and member management.
 *   - member: full project control except adding members and deleting the project.
 *   - viewer: read-only.
 *
 * Callers pass the internal user UUID (already resolved via UsersService).
 * Superadmins (User.isSuperAdmin) bypass every check.
 */
// Process-local cache, same multi-pod caveat as MembershipCacheService.
// invalidateSuperAdmin is called when the flag is toggled in this process, but
// other pods only learn about it when this TTL expires.
const SUPERADMIN_TTL_MS = 1_000;

@Injectable()
export class AuthorizationService {
  // userId → { value, expiresAt }. TTL'd because superadmin status is sticky
  // (toggled rarely from /admin) and we hit this check on every authz call.
  private readonly superAdminCache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async isSuperAdmin(userId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.superAdminCache.get(userId);
    if (hit && hit.expiresAt > now) return hit.value;

    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true },
    });
    const value = Boolean(u?.isSuperAdmin);
    this.superAdminCache.set(userId, { value, expiresAt: now + SUPERADMIN_TTL_MS });
    return value;
  }

  /** Drop the cached isSuperAdmin entry for a user. Call after toggling the flag. */
  invalidateSuperAdmin(userId: string) {
    this.superAdminCache.delete(userId);
  }

  // ──────────────────────────── organisation ────────────────────────────

  async getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null> {
    if (await this.isSuperAdmin(userId)) {
      // Confirm the org actually exists. Without this, superadmins probing a
      // random UUID got a synthetic owner membership and downstream endpoints
      // returned inconsistent shapes (empty list vs 404), which is both a
      // fuzzing oracle and a foot-gun for write endpoints keyed on the bogus id.
      const exists = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!exists) return null;
      return { organizationId, role: 'owner', isAdmin: true };
    }
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    if (!member) return null;
    return {
      organizationId,
      role: member.role,
      isAdmin: member.role === 'owner' || member.role === 'admin',
    };
  }

  /** Read access on the organisation. Returns 404 to non-members so the resource is undiscoverable. */
  async requireOrgMember(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.getOrgAccess(organizationId, userId);
    if (!access) {
      throw new NotFoundException('Organization not found');
    }
    return access;
  }

  /** Settings / member management on the organisation — owners and admins only. */
  async requireOrgAdmin(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (!access.isAdmin) {
      throw new ForbiddenException('Only organization owners and admins can perform this action');
    }
    return access;
  }

  /**
   * Project creation gate. Guests are explicitly forbidden from spawning new
   * projects — they only ever interact with projects they've been added to.
   * Everyone else (owner / admin / member) can create.
   */
  async requireOrgCanCreateProjects(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (access.role === 'guest') {
      throw new ForbiddenException('Guests cannot create projects in this organization');
    }
    return access;
  }

  async requireOrgOwner(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (access.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can perform this action');
    }
    return access;
  }

  // ──────────────────────────── project ────────────────────────────

  /**
   * Resolve a user's effective access to a project.
   * Returns null if the user has no path to the project (not org member, not project member).
   */
  async getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true },
    });
    if (!project) return null;
    return this.resolveProjectAccess(project.id, project.organizationId, userId);
  }

  /**
   * Same as getProjectAccess but skips the project lookup when the caller already
   * has the organizationId on hand (lets us avoid a redundant query in hot paths).
   */
  async resolveProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
  ): Promise<ProjectAccess | null> {
    if (await this.isSuperAdmin(userId)) {
      return {
        projectId,
        organizationId,
        source: 'superadmin',
        orgRole: 'owner',
        projectRoleName: 'admin',
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true,
      };
    }

    const [orgMember, projectMember] = await Promise.all([
      this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
      }),
      this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        include: { role: true },
      }),
    ]);

    // Org admins/owners see and control every project in the org.
    if (orgMember && (orgMember.role === 'owner' || orgMember.role === 'admin')) {
      return {
        projectId,
        organizationId,
        source: 'orgAdmin',
        orgRole: orgMember.role,
        projectRoleName: (projectMember?.role.name as ProjectRoleName | undefined) ?? null,
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true,
      };
    }

    // Invariant: project access requires org membership. A ProjectMember row
    // without an OrganizationMember row is an orphan (e.g. partial cleanup) and
    // must not grant access.
    if (!orgMember) return null;

    if (!projectMember) {
      // Plain org members without a project membership cannot see the project at all.
      return null;
    }

    const roleName = projectMember.role.name as ProjectRoleName;
    if (roleName === 'admin') {
      return {
        projectId,
        organizationId,
        source: 'projectMember',
        orgRole: orgMember?.role ?? null,
        projectRoleName: 'admin',
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true,
      };
    }
    if (roleName === 'member') {
      return {
        projectId,
        organizationId,
        source: 'projectMember',
        orgRole: orgMember?.role ?? null,
        projectRoleName: 'member',
        canView: true,
        canEdit: true,
        canManageMembers: false,
        canDelete: false,
      };
    }
    // viewer (or any unknown role name → treated as read-only, never as edit)
    return {
      projectId,
      organizationId,
      source: 'projectMember',
      orgRole: orgMember?.role ?? null,
      projectRoleName: 'viewer',
      canView: true,
      canEdit: false,
      canManageMembers: false,
      canDelete: false,
    };
  }

  /** View access. Throws 404 (not 403) when the user has no path to the project. */
  async requireProjectView(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.getProjectAccess(projectId, userId);
    if (!access || !access.canView) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return access;
  }

  /** Mutate deployments/services/ingresses/databases/etc. — viewers are blocked. */
  async requireProjectEdit(projectId: string, userId: string, action = 'modify this project'): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    if (!access.canEdit) {
      throw new ForbiddenException(`Your role does not allow you to ${action}`);
    }
    return access;
  }

  async requireProjectManageMembers(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    if (!access.canManageMembers) {
      throw new ForbiddenException('Only project admins or organization admins can manage project members');
    }
    return access;
  }

  async requireProjectDelete(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    if (!access.canDelete) {
      throw new ForbiddenException('Only project admins or organization admins can delete this project');
    }
    return access;
  }

  /**
   * For list endpoints. Returns the set of project IDs the user can see in the org.
   * If the user is an org admin/owner, returns null meaning "no filter — show every project in the org".
   * If the user is a plain org member, returns the explicit list of project IDs they belong to.
   * If the user is not an org member at all, throws 404.
   */
  async listVisibleProjectIds(organizationId: string, userId: string): Promise<string[] | null> {
    if (await this.isSuperAdmin(userId)) return null;

    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new NotFoundException('Organization not found');
    }
    if (member.role === 'owner' || member.role === 'admin') return null;

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true },
    });
    return memberships.map((m) => m.projectId);
  }
}
