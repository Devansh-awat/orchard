import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { EmailService } from '../email/email.service';
import { AuthorizationService } from '../auth/authorization.service';
import { OrganizationMember, OrganizationRole, Role, WorkspaceMember } from '@prisma/client';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly authz: AuthorizationService,
  ) {}

  private async resolveUserId(clerkId: string, userData?: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  private formatSlug(value: string) {
    if (!value) {
      return '';
    }

    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }

  async createWorkspace(
    organizationId: string,
    data: { name: string; slug?: string; description?: string },
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

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const name = String(data.name || '').trim();

    if (!name) {
      throw new BadRequestException('Workspace name is required');
    }

    const slugSource = data.slug && data.slug.trim() ? data.slug : name;
    const slug = this.formatSlug(slugSource);

    if (!slug) {
      throw new BadRequestException('Workspace slug cannot be empty');
    }

    const existing = await this.prisma.workspace.findUnique({
      where: {
        organizationId_slug: {
          organizationId,
          slug,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('A workspace with this slug already exists in the organization');
    }

    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
    });

    if (!adminRole) {
      throw new NotFoundException('Workspace admin role is not configured');
    }

    const workspace = await this.prisma.workspace.create({
      data: {
        organizationId,
        name,
        slug,
        description: data.description?.trim() || null,
        createdBy: user.id,
        members: {
          create: {
            userId: user.id,
            roleId: adminRole.id,
            addedBy: user.id,
          },
        },
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true,
          },
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true,
                hackClubId: true,
              },
            },
            role: true,
          },
        },
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
              },
            },
          },
        },
        _count: {
          select: {
            members: true,
            projects: true,
          },
        },
      },
    });

    for (const member of workspace.members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return workspace;
  }

  async listWorkspaces(clerkId: string, userData?: {
    email?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    imageUrl?: string;
  }) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const userWorkspaces = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });

    const userWorkspaceIds = userWorkspaces.map(wm => wm.workspaceId);

    const userOrganizations = await this.prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true, role: true },
    });

    const orgIds = userOrganizations.map(om => om.organizationId);
    const isAdminOrOwner = userOrganizations.some(om => om.role === 'owner' || om.role === 'admin');

    const whereClause = isAdminOrOwner
      ? { organizationId: { in: orgIds } }
      : { id: { in: userWorkspaceIds } };

    return this.prisma.workspace.findMany({
      where: whereClause,
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        members: {
          where: { userId: user.id },
          select: { id: true },
        },
        _count: {
          select: {
            members: true,
            projects: true,
          },
        },
      },
    });
  }

  async getWorkspace(workspaceId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const wsOwner = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!wsOwner) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    await this.authz.requireOrgMember(wsOwner.organizationId, userId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true,
                hackClubId: true,
              },
            },
            role: true,
          },
        },
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
              },
            },
          },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    for (const member of workspace.members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return workspace;
  }

  async deleteWorkspace(workspaceId: string, clerkId: string, force: boolean = false) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        _count: {
          select: {
            projects: true,
          },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw new ForbiddenException('Only organization owners and admins can delete workspaces');
    }

    if (workspace._count.projects > 0 && !force) {
      throw new BadRequestException(
        `Workspace has ${workspace._count.projects} project(s). Delete them first, or use force=true to cascade delete all projects and their resources.`
      );
    }

    if (workspace._count.projects > 0 && force) {
      // Cascade: delete all projects and their resources
      const projects = await this.prisma.project.findMany({
        where: { workspaceId },
        select: { id: true },
      });

      for (const project of projects) {
        // Delete ingresses, services, deployments, databases etc. in correct order
        await this.prisma.ingress.deleteMany({ where: { projectId: project.id } });

        const deployments = await this.prisma.deployment.findMany({
          where: { projectId: project.id },
          select: { id: true },
        });

        for (const dep of deployments) {
          await this.prisma.servicePort.deleteMany({
            where: { service: { deploymentId: dep.id } },
          });
          await this.prisma.service.deleteMany({ where: { deploymentId: dep.id } });
          await this.prisma.envVar.deleteMany({ where: { deploymentId: dep.id } });
          await this.prisma.pod.deleteMany({ where: { deploymentId: dep.id } });
          await this.prisma.volume.deleteMany({ where: { deploymentId: dep.id } });
        }

        await this.prisma.deployment.deleteMany({ where: { projectId: project.id } });
        await this.prisma.database.deleteMany({ where: { projectId: project.id } });
        await this.prisma.templateInstance.deleteMany({ where: { projectId: project.id } });
        await this.prisma.project.delete({ where: { id: project.id } });
      }
    }

    await this.prisma.$transaction([
      this.prisma.workspaceMember.deleteMany({
        where: { workspaceId },
      }),
      this.prisma.workspace.delete({
        where: { id: workspaceId },
      }),
    ]);

    return { success: true };
  }

  async getWorkspaceBySlug(slug: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const workspaces = await this.prisma.workspace.findMany({
      where: { slug },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true,
                hackClubId: true,
              },
            },
            role: true,
          },
        },
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
              },
            },
          },
        },
      },
    });

    if (!workspaces || workspaces.length === 0) {
      throw new NotFoundException(`Workspace with slug ${slug} not found`);
    }

    const workspace = workspaces[0];
    await this.authz.requireOrgMember(workspace.organization.id, userId);

    for (const member of workspace.members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return workspace;
  }

  async getWorkspaceProjects(workspaceId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    await this.authz.requireOrgMember(workspace.organizationId, userId);

    return this.prisma.project.findMany({
      where: { workspaceId },
      include: {
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        _count: {
          select: {
            deployments: true,
          },
        },
      },
    });
  }

  async addMemberToWorkspace(
    workspaceId: string,
    userId: string,
    roleId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const adder = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!adder) {
      throw new NotFoundException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: true,
        members: {
          where: { userId: adder.id },
          include: { role: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const isWorkspaceAdmin = workspace.members.some(m => m.role.name === 'admin' && m.userId === adder.id);
    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId: adder.id,
        },
      },
    });

    const isOrgAdminOrOwner = orgMembership && (orgMembership.role === 'owner' || orgMembership.role === 'admin');

    if (!isWorkspaceAdmin && !isOrgAdminOrOwner) {
      throw new ForbiddenException('Only workspace admins or organization admins/owners can add members');
    }

    const orgMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId,
        },
      },
    });

    if (!orgMember) {
      throw new BadRequestException('User must be an organization member first');
    }

    const existingMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
      },
    });

    if (existingMember) {
      throw new BadRequestException('User is already a member of this workspace');
    }

    const member = await this.prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        roleId,
        addedBy: adder.id,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true,
            hackClubId: true,
          },
        },
        role: true,
      },
    });

    if (!member.user.imageUrl && member.user.hackClubId) {
      const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
      if (imageUrl) {
        member.user.imageUrl = imageUrl;
      }
    }

    return member;
  }

  async inviteMemberToWorkspace(
    workspaceId: string,
    userId: string,
    roleId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const inviter = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!inviter) {
      throw new NotFoundException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: true,
        members: {
          where: { userId: inviter.id },
          include: { role: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const isWorkspaceAdmin = workspace.members.some(m => m.role.name === 'admin' && m.userId === inviter.id);
    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId: inviter.id,
        },
      },
    });

    const isOrgAdminOrOwner = orgMembership && (orgMembership.role === 'owner' || orgMembership.role === 'admin');

    if (!isWorkspaceAdmin && !isOrgAdminOrOwner) {
      throw new ForbiddenException('Only workspace admins or organization admins/owners can invite members');
    }

    const orgMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId,
        },
      },
    });

    if (!orgMember) {
      throw new BadRequestException('User must be an organization member first');
    }

    const existingMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
      },
    });

    if (existingMember) {
      throw new BadRequestException('User is already a member of this workspace');
    }

    const existingInvitation = await this.prisma.workspaceInvitation.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });

    if (existingInvitation) {
      throw new BadRequestException('User already has a pending invitation');
    }

    const invitation = await this.prisma.workspaceInvitation.create({
      data: {
        workspaceId,
        userId,
        roleId,
        invitedBy: inviter.id,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true,
          },
        },
        role: true,
        inviter: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName = inviter.firstName && inviter.lastName
      ? `${inviter.firstName} ${inviter.lastName}`
      : inviter.username || inviter.email || 'Someone';
    const recipientName = invitation.user.firstName && invitation.user.lastName
      ? `${invitation.user.firstName} ${invitation.user.lastName}`
      : invitation.user.username || invitation.user.email || 'there';

    this.emailService.sendWorkspaceInviteEmail({
      recipientEmail: invitation.user.email,
      recipientName,
      workspaceName: workspace.name,
      organizationName: workspace.organization.name,
      inviterName,
      role: invitation.role.name,
      inviteUrl: `${frontendUrl}/workspaces/${workspace.slug}`,
    }).catch(err => {
      console.error('Failed to send workspace invite email:', err);
    });

    return invitation;
  }

  async joinWorkspace(
    workspaceId: string,
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

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspace.organizationId,
          userId: user.id,
        },
      },
    });

    if (!orgMembership) {
      throw new ForbiddenException('You must be a member of the organization to join workspaces');
    }

    const isOrgAdminOrOwner = orgMembership.role === 'owner' || orgMembership.role === 'admin';

    const existingMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId: user.id,
      },
    });

    if (existingMember) {
      throw new BadRequestException('You are already a member of this workspace');
    }

    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: user.id,
        },
      },
    });

    if (!invitation && !isOrgAdminOrOwner) {
      throw new ForbiddenException('You must be invited to join this workspace, or be an organization admin/owner');
    }

    const roleId = invitation ? invitation.roleId : await this.prisma.role.findUnique({
      where: { name: 'member' },
    }).then(r => r?.id);

    if (!roleId) {
      throw new NotFoundException('Default member role not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.create({
        data: {
          workspaceId,
          userId: user.id,
          roleId,
          addedBy: user.id,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              imageUrl: true,
              hackClubId: true,
            },
          },
          role: true,
        },
      });

      if (invitation) {
        await tx.workspaceInvitation.delete({
          where: { id: invitation.id },
        });
      }

      return member;
    });

    if (!result.user.imageUrl && result.user.hackClubId) {
      const imageUrl = await this.usersService.syncImageUrlFromClerk(result.user.hackClubId);
      if (imageUrl) {
        result.user.imageUrl = imageUrl;
      }
    }

    return result;
  }

  async leaveWorkspace(
    workspaceId: string,
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

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          where: { userId: user.id },
          include: { role: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const membership = workspace.members.find(m => m.userId === user.id);

    if (!membership) {
      throw new BadRequestException('You are not a member of this workspace');
    }

    const isAdmin = membership.role.name === 'admin';
    const adminCount = await this.prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: {
          name: 'admin',
        },
      },
    });

    if (isAdmin && adminCount === 1) {
      throw new BadRequestException('Cannot leave workspace as the only admin. Please assign another admin first or delete the workspace.');
    }

    await this.prisma.workspaceMember.deleteMany({
      where: {
        workspaceId,
        userId: user.id,
      },
    });

    await this.prisma.workspaceInvitation.deleteMany({
      where: {
        workspaceId,
        userId: user.id,
      },
    });

    return { success: true };
  }

  async getRoles() {
    return this.prisma.role.findMany({
      orderBy: { name: 'asc' },
    });
  }
}
