import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { Prisma } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';
import { ACCOUNT_SCOPE } from '../users/account-scope';
import { UsersService } from '../users/users.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly settings: InstanceSettingsService,
    private readonly users: UsersService
  ) {}

  async getStats() {
    const [userCount, orgCount, projectCount, deploymentCount] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.organization.count(),
      this.prisma.project.count(),
      this.prisma.deployment.count()
    ]);

    return { userCount, orgCount, projectCount, deploymentCount };
  }

  async getAllUsers(page = 1, limit = 20, search?: string) {
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          imageUrl: true,
          isSuperAdmin: true,
          createdAt: true,
          disabledAt: true,
          homeOrganizationId: true,
          _count: {
            select: {
              organizationMembers: true,
              projectMembers: true
            }
          }
        }
      }),
      this.prisma.user.count({ where })
    ]);

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        isSuperAdmin: true,
        createdAt: true,
        updatedAt: true,
        organizationMembers: {
          include: { organization: { select: { id: true, name: true, slug: true } } }
        },
        projectMembers: {
          include: {
            project: { select: { id: true, name: true, slug: true } },
            role: { select: { name: true } }
          }
        }
      }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateUser(
    userId: string,
    requesterId: string,
    data: {
      firstName?: string;
      lastName?: string;
      isSuperAdmin?: boolean;
    }
  ) {
    if (data.isSuperAdmin === false && userId === requesterId) {
      throw new ForbiddenException("You can't remove your own superadmin status");
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.isSuperAdmin !== undefined && { isSuperAdmin: data.isSuperAdmin })
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true
      }
    });

    if (data.isSuperAdmin !== undefined && data.isSuperAdmin !== user.isSuperAdmin) {
      this.authz.invalidateSuperAdmin(userId);
      void this.audit.log({
        action: data.isSuperAdmin ? 'user.superadmin.granted' : 'user.superadmin.revoked',
        actorUserId: requesterId,
        targetType: 'user',
        targetId: userId,
        targetLabel: user.email
      });
    }

    return updated;
  }

  async setUserDisabled(userId: string, requesterId: string, disabled: boolean, reason?: string) {
    if (userId === requesterId) {
      throw new ForbiddenException("You can't turn off your own account");
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (disabled && user.isSuperAdmin) {
      const others = await this.prisma.user.count({
        where: { isSuperAdmin: true, disabledAt: null, id: { not: userId } }
      });
      if (others === 0) throw new ForbiddenException("You can't turn off the last superadmin");
    }
    await this.users.setDisabled(userId, disabled, reason);
    void this.audit.log({
      action: disabled ? 'user.disabled' : 'user.enabled',
      actorUserId: requesterId,
      targetType: 'user',
      targetId: userId,
      targetLabel: user.email
    });
    return { success: true, disabled };
  }

  async deleteUser(userId: string, requesterId: string) {
    if (userId === requesterId) {
      throw new ForbiddenException("You can't delete your own account");
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.delete({ where: { id: userId } });

    void this.audit.log({
      action: 'user.deleted',
      actorUserId: requesterId,
      targetType: 'user',
      targetId: userId,
      targetLabel: user.email
    });

    return { success: true };
  }

  async getAllOrganizations(page = 1, limit = 20, search?: string) {
    const where: Prisma.OrganizationWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {};

    const [organizations, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          avatarUrl: true,
          plan: true,
          createdAt: true,
          creator: {
            select: { id: true, email: true, username: true, firstName: true, lastName: true }
          },
          _count: {
            select: {
              members: true,
              projects: true
            }
          }
        }
      }),
      this.prisma.organization.count({ where })
    ]);

    return {
      organizations,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async createOrganization(
    data: {
      name: string;
      slug: string;
      description?: string;
      avatarUrl?: string;
      plan?: string;
      primaryOwnerEmail?: string;
    },
    inviterId?: string,
    options: { applyDefaultCaps?: boolean } = {}
  ) {
    let primaryOwnerId: string | undefined;

    if (data.primaryOwnerEmail?.trim()) {
      const email = data.primaryOwnerEmail.trim().toLowerCase();
      const user = await this.prisma.user.findFirst({
        where: { emailScope: ACCOUNT_SCOPE, email: { equals: email, mode: 'insensitive' } }
      });
      if (user) {
        primaryOwnerId = user.id;
      }
    }

    const org = await this.prisma.organization.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description,
        avatarUrl: data.avatarUrl,
        plan: data.plan,
        createdBy: primaryOwnerId,
        ...(options.applyDefaultCaps === false ? {} : await this.settings.getNewOrgCaps())
      }
    });

    void this.audit.log({
      action: 'org.created',
      actorUserId: inviterId ?? null,
      organizationId: org.id,
      targetType: 'organization',
      targetId: org.id,
      targetLabel: org.name,
      metadata: { slug: org.slug, plan: org.plan ?? null }
    });

    if (primaryOwnerId) {
      await this.prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: primaryOwnerId,
          role: 'owner'
        }
      });
      void this.audit.log({
        action: 'org.member.added',
        actorUserId: inviterId ?? null,
        organizationId: org.id,
        targetType: 'user',
        targetId: primaryOwnerId,
        metadata: { role: 'owner', via: 'admin_create' }
      });
      return { organization: org };
    }

    if (data.primaryOwnerEmail?.trim() && inviterId) {
      const email = data.primaryOwnerEmail.trim().toLowerCase();
      const token = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await this.prisma.organizationInvitation.create({
        data: {
          organizationId: org.id,
          email,
          role: 'owner',
          token: null,
          tokenHash,
          invitedBy: inviterId,
          expiresAt
        }
      });
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const inviteLink = `${frontendUrl}/invite/${token}`;
      return { organization: org, inviteLink };
    }

    return { organization: org };
  }

  async updateOrganization(orgId: string, data: { name?: string; description?: string }) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description })
      }
    });

    const meta: Record<string, [unknown, unknown]> = {};
    if (data.name !== undefined && data.name !== org.name) meta.name = [org.name, data.name];
    if (data.description !== undefined && data.description !== org.description)
      meta.description = [org.description, data.description];
    if (Object.keys(meta).length) {
      void this.audit.log({
        action: 'org.updated',
        organizationId: orgId,
        targetType: 'organization',
        targetId: orgId,
        targetLabel: updated.name,
        metadata: meta
      });
    }

    // Backup credentials are write-only over the API.
    const { backupR2AccessKey, backupR2SecretKey, ...safe } = updated as any;
    return {
      ...safe,
      backupR2AccessKeyConfigured: Boolean(backupR2AccessKey),
      backupR2SecretKeyConfigured: Boolean(backupR2SecretKey)
    };
  }

  async deleteOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    await this.prisma.organization.delete({ where: { id: orgId } });

    // Log to global ledger only (organizationId is null because the org no longer exists / cascade safety).
    void this.audit.log({
      action: 'org.deleted',
      targetType: 'organization',
      targetId: orgId,
      targetLabel: org.name,
      metadata: { slug: org.slug }
    });

    return { success: true };
  }
}
