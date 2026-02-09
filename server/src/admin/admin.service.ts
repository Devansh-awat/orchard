import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const [userCount, orgCount, workspaceCount, projectCount, deploymentCount] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.organization.count(),
        this.prisma.workspace.count(),
        this.prisma.project.count(),
        this.prisma.deployment.count(),
      ]);

    return { userCount, orgCount, workspaceCount, projectCount, deploymentCount };
  }

  // --- Users ---

  async getAllUsers(page: number = 1, limit: number = 20, search?: string) {
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
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
          _count: {
            select: {
              organizationMembers: true,
              workspaceMembers: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
          include: { organization: { select: { id: true, name: true, slug: true } } },
        },
        workspaceMembers: {
          include: {
            workspace: { select: { id: true, name: true, slug: true } },
            role: { select: { name: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateUser(
    userId: string,
    requesterId: string,
    data: { firstName?: string; lastName?: string; isSuperAdmin?: boolean },
  ) {
    if (data.isSuperAdmin === false && userId === requesterId) {
      throw new ForbiddenException('Cannot remove your own superadmin status');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.isSuperAdmin !== undefined && { isSuperAdmin: data.isSuperAdmin }),
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true,
      },
    });
  }

  async deleteUser(userId: string, requesterId: string) {
    if (userId === requesterId) {
      throw new ForbiddenException('Cannot delete your own account');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.delete({ where: { id: userId } });
    return { success: true };
  }

  // --- Organizations ---

  async getAllOrganizations(page: number = 1, limit: number = 20, search?: string) {
    const where: Prisma.OrganizationWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
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
            select: { id: true, email: true, username: true, firstName: true, lastName: true },
          },
          _count: {
            select: {
              members: true,
              workspaces: true,
            },
          },
        },
      }),
      this.prisma.organization.count({ where }),
    ]);

    return {
      organizations,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
  ) {
    let primaryOwnerId: string | undefined;

    if (data.primaryOwnerEmail?.trim()) {
      const email = data.primaryOwnerEmail.trim().toLowerCase();
      const user = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
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
      },
    });

    if (primaryOwnerId) {
      await this.prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: primaryOwnerId,
          role: 'owner',
        },
      });
      return { organization: org };
    }

    if (data.primaryOwnerEmail?.trim() && inviterId) {
      const email = data.primaryOwnerEmail.trim().toLowerCase();
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await this.prisma.organizationInvitation.create({
        data: {
          organizationId: org.id,
          email,
          role: 'owner',
          token,
          invitedBy: inviterId,
          expiresAt,
        },
      });
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const inviteLink = `${frontendUrl}/invite/${token}`;
      return { organization: org, inviteLink };
    }

    return { organization: org };
  }

  async updateOrganization(orgId: string, data: { name?: string; description?: string }) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    return this.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async deleteOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    await this.prisma.organization.delete({ where: { id: orgId } });
    return { success: true };
  }
}
