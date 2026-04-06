import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationRole } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { StorageService } from './storage.service';
import { EmailService } from '../email/email.service';
import { randomBytes } from 'crypto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService
  ) {}

  async checkPermission(organizationId: string, userId: string, requiredRole: 'owner' | 'admin') {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId
        }
      }
    });

    if (!member) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    if (requiredRole === 'owner' && member.role !== 'owner') {
      throw new ForbiddenException('Only organization owners can perform this action');
    }

    if (requiredRole === 'admin' && member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException('Only organization owners and admins can perform this action');
    }

    return member;
  }

  async getUserOrganizations(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    
    if (!user) {
      return [];
    }

    return this.prisma.organization.findMany({
      where: {
        members: {
          some: {
            userId: user.id
          }
        }
      },
      include: {
        _count: {
          select: {
            projects: true,
            members: true
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    });
  }

  async getOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true
              }
            }
          }
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
                hackClubId: true
              }
            }
          }
        }
      }
    });

    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    for (const member of organization.members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return organization;
  }

  async getOrganizationMembers(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
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
      },
      orderBy: { addedAt: 'asc' },
    });

    for (const member of members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return members;
  }

  async getOrganizationBySlug(slug: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true
              }
            }
          }
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
                hackClubId: true
              }
            }
          }
        }
      }
    });

    if (!organization) {
      throw new NotFoundException(`Organization with slug ${slug} not found`);
    }

    for (const member of organization.members) {
      if (!member.user.imageUrl && member.user.hackClubId) {
        const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
        if (imageUrl) {
          member.user.imageUrl = imageUrl;
        }
      }
    }

    return organization;
  }

  async getMembershipByUserId(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id
        }
      }
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    return membership;
  }

  async updateOrganization(
    organizationId: string,
    clerkId: string,
    data: { name?: string; description?: string },
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: updateData,
      include: {
        projects: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true
              }
            }
          }
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
                imageUrl: true
              }
            }
          }
        }
      }
    });
  }

  async uploadAvatar(
    organizationId: string,
    clerkId: string,
    file: Express.Multer.File,
    storageService: StorageService,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const avatarUrl = await storageService.uploadFile(file, 'organizations');

    if (organization.avatarUrl) {
      try {
        await storageService.deleteFile(organization.avatarUrl);
      } catch (error) {
        console.error('Failed to delete old avatar:', error);
      }
    }

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: { avatarUrl },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true
              }
            }
          }
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
                imageUrl: true
              }
            }
          }
        }
      }
    });
  }

  async deleteAvatar(
    organizationId: string,
    clerkId: string,
    storageService: StorageService,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.avatarUrl) {
      try {
        await storageService.deleteFile(organization.avatarUrl);
      } catch (error) {
        console.error('Failed to delete avatar:', error);
      }
    }

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: { avatarUrl: null },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true
              }
            }
          }
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
                imageUrl: true
              }
            }
          }
        }
      }
    });
  }

  async inviteMemberToOrganization(
    organizationId: string,
    email: string,
    role: OrganizationRole,
    invitedByClerkId: string,
    userData?: any
  ) {
    const inviter = await this.usersService.findOrCreateByClerkId(invitedByClerkId, userData);

    if (!inviter) {
      throw new NotFoundException('Inviter not found');
    }

    await this.checkPermission(organizationId, inviter.id, 'admin');

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists and is already a member
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: existingUser.id
          }
        }
      });

      if (existingMember) {
        throw new BadRequestException('User is already a member of this organization');
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await this.prisma.organizationInvitation.findUnique({
      where: {
        organizationId_email: {
          organizationId,
          email: normalizedEmail
        }
      }
    });

    if (existingInvitation) {
      throw new BadRequestException('An invitation has already been sent to this email');
    }

    // Generate secure token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId,
        email: normalizedEmail,
        role,
        token,
        invitedBy: inviter.id,
        expiresAt
      },
      include: {
        organization: true,
        inviter: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName = inviter.firstName && inviter.lastName
      ? `${inviter.firstName} ${inviter.lastName}`
      : inviter.username || inviter.email || 'Someone';

    this.emailService.sendOrganizationInviteEmail({
      recipientEmail: normalizedEmail,
      recipientName: normalizedEmail.split('@')[0],
      organizationName: organization.name,
      inviterName,
      role,
      loginUrl: frontendUrl,
    }).catch(err => {
      console.error('Failed to send organization invite email:', err);
    });

    return invitation;
  }

  async acceptInvitationByToken(token: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
      include: { organization: true }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found or has expired');
    }

    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw new BadRequestException('Invitation has expired');
    }

    // Verify the user's email matches the invitation
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException('This invitation was sent to a different email address');
    }

    // Check if already a member
    const existingMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: user.id
        }
      }
    });

    if (existingMember) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw new BadRequestException('You are already a member of this organization');
    }

    // Create membership and delete invitation in a transaction
    const member = await this.prisma.$transaction(async (tx) => {
      const newMember = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
          addedBy: invitation.invitedBy
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              imageUrl: true
            }
          },
          organization: true
        }
      });

      await tx.organizationInvitation.delete({ where: { id: invitation.id } });

      return newMember;
    });

    return member;
  }

  async acceptPendingInvitationsForUser(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      return [];
    }

    // Find all pending invitations for this user's email
    const pendingInvitations = await this.prisma.organizationInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        expiresAt: { gt: new Date() }
      },
      include: { organization: true }
    });

    const acceptedOrgs = [];

    for (const invitation of pendingInvitations) {
      // Check if already a member
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id
          }
        }
      });

      if (!existingMember) {
        await this.prisma.$transaction(async (tx) => {
          await tx.organizationMember.create({
            data: {
              organizationId: invitation.organizationId,
              userId: user.id,
              role: invitation.role,
              addedBy: invitation.invitedBy
            }
          });

          await tx.organizationInvitation.delete({ where: { id: invitation.id } });
        });

        acceptedOrgs.push(invitation.organization);
      } else {
        // Clean up the invitation if already a member
        await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      }
    }

    return acceptedOrgs;
  }

  async getInvitationByToken(token: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

    return invitation;
  }

  async getPendingInvitationsForUser(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      return [];
    }

    return this.prisma.organizationInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        expiresAt: { gt: new Date() }
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async declineInvitationByToken(token: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify the user's email matches the invitation
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException('This invitation was sent to a different email address');
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });

    return { success: true, message: 'Invitation declined' };
  }

  async getOrganizationInvitations(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    return this.prisma.organizationInvitation.findMany({
      where: {
        organizationId,
        expiresAt: { gt: new Date() }
      },
      include: {
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async cancelInvitation(invitationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    await this.checkPermission(invitation.organizationId, user.id, 'admin');

    await this.prisma.organizationInvitation.delete({ where: { id: invitationId } });

    return { success: true, message: 'Invitation cancelled' };
  }

  async resendInvitation(invitationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: {
        organization: true,
        inviter: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

    await this.checkPermission(invitation.organizationId, user.id, 'admin');

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName = invitation.inviter.firstName && invitation.inviter.lastName
      ? `${invitation.inviter.firstName} ${invitation.inviter.lastName}`
      : invitation.inviter.username || invitation.inviter.email || 'Someone';

    this.emailService.sendOrganizationInviteEmail({
      recipientEmail: invitation.email,
      recipientName: invitation.email.split('@')[0],
      organizationName: invitation.organization.name,
      inviterName,
      role: invitation.role,
      loginUrl: frontendUrl,
    }).catch(err => {
      console.error('Failed to resend organization invite email:', err);
    });

    return { success: true, message: 'Invitation resent' };
  }

  async removeMemberFromOrganization(
    organizationId: string,
    memberId: string,
    removedBy: string,
    userData?: any
  ) {
    const remover = await this.usersService.findOrCreateByClerkId(removedBy, userData);
    
    if (!remover) {
      throw new NotFoundException('User removing member not found');
    }

    await this.checkPermission(organizationId, remover.id, 'admin');

    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: true }
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (member.role === 'owner') {
      throw new BadRequestException('Cannot remove organization owner');
    }

    await this.prisma.organizationMember.delete({
      where: { id: memberId }
    });

    // If user no longer belongs to any organization, reset their setup
    const remainingMemberships = await this.prisma.organizationMember.count({
      where: { userId: member.userId }
    });

    if (remainingMemberships === 0) {
      await this.prisma.user.update({
        where: { id: member.userId },
        data: { setupCompleted: false }
      });
    }

    return { success: true, message: 'Member removed from organization' };
  }

  async updateMemberRole(
    organizationId: string,
    memberId: string,
    newRole: OrganizationRole,
    updatedBy: string,
    userData?: any
  ) {
    const updater = await this.usersService.findOrCreateByClerkId(updatedBy, userData);
    
    if (!updater) {
      throw new NotFoundException('User updating role not found');
    }

    await this.checkPermission(organizationId, updater.id, 'owner');

    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId }
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (member.role === 'owner' && newRole !== 'owner') {
      throw new BadRequestException('Cannot change owner role. Transfer ownership instead.');
    }

    return this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { role: newRole },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true
          }
        }
      }
    });
  }

}

