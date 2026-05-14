import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationRole } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { StorageService } from './storage.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { randomBytes } from 'crypto';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly membershipCache: MembershipCacheService,
    private readonly tailscale: TailscaleService,
  ) {}

  async checkPermission(organizationId: string, userId: string, requiredRole: 'owner' | 'admin') {
    if (requiredRole === 'owner') {
      await this.authz.requireOrgOwner(organizationId, userId);
    } else {
      await this.authz.requireOrgAdmin(organizationId, userId);
    }
    return this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }

  private async resolveUserId(clerkId: string, userData?: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  async getUserOrganizations(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      return [];
    }

    const isSuperAdmin = await this.authz.isSuperAdmin(user.id);

    const orgs = await this.prisma.organization.findMany({
      where: isSuperAdmin
        ? undefined
        : { members: { some: { userId: user.id } } },
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
    return orgs.map((o) => this.scrubOrgSecrets(o as any));
  }

  // Backup credentials are write-only over the API. We never return the access key
  // or the secret access key in plaintext — only a "configured" flag and the last
  // 4 chars of the access key so an operator can recognize which credential is set.
  private scrubOrgSecrets<T extends { backupR2SecretKey?: string | null; backupR2AccessKey?: string | null }>(
    org: T | null,
  ): T | null {
    if (!org) return org;
    const accessKey = org.backupR2AccessKey ?? null;
    const hasSecret = Boolean(org.backupR2SecretKey);
    const hasAccessKey = Boolean(accessKey);
    const clone: any = {
      ...org,
      backupR2SecretKey: null,
      backupR2SecretKeyConfigured: hasSecret,
      backupR2AccessKey: null,
      backupR2AccessKeyConfigured: hasAccessKey,
      backupR2AccessKeyLast4:
        accessKey && accessKey.length >= 4 ? accessKey.slice(-4) : null,
    };
    return clone;
  }

  async getBackupSettings(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    await this.checkPermission(organizationId, user.id, 'admin');
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        backupR2Endpoint: true,
        backupR2Bucket: true,
        backupR2Region: true,
        backupR2AccessKey: true,
        backupR2SecretKey: true,
        databasePublicIp: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    const accessKey = org.backupR2AccessKey;
    return {
      endpoint: org.backupR2Endpoint,
      bucket: org.backupR2Bucket,
      region: org.backupR2Region,
      // Write-only: never return the access key value. Surface a fingerprint instead.
      accessKeyConfigured: Boolean(accessKey),
      accessKeyLast4: accessKey && accessKey.length >= 4 ? accessKey.slice(-4) : null,
      secretKeyConfigured: Boolean(org.backupR2SecretKey),
      databasePublicIp: org.databasePublicIp,
    };
  }

  async getOrganization(organizationId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireOrgMember(organizationId, userId);
    const visibleProjectIds = await this.authz.listVisibleProjectIds(organizationId, userId);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        projects: {
          where: visibleProjectIds === null ? undefined : { id: { in: visibleProjectIds } },
          include: {
            _count: {
              select: {
                deployments: true,
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

    await Promise.all(
      organization.members.map(async (member) => {
        if (!member.user.imageUrl && member.user.hackClubId) {
          const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
          if (imageUrl) member.user.imageUrl = imageUrl;
        }
      }),
    );

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId); // always include self
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId'],
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      (organization as any).members = organization.members.filter(
        (m) => coMemberIds.has(m.user.id),
      );
    }

    return this.scrubOrgSecrets(organization as any);
  }

  async getOrganizationMembers(organizationId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireOrgMember(organizationId, userId);
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

    await Promise.all(
      members.map(async (member) => {
        if (!member.user.imageUrl && member.user.hackClubId) {
          const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
          if (imageUrl) member.user.imageUrl = imageUrl;
        }
      }),
    );

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const visibleProjectIds = await this.authz.listVisibleProjectIds(organizationId, userId);
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId);
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId'],
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      return members.filter((m) => coMemberIds.has(m.user.id));
    }

    return members;
  }

  async getOrganizationBySlug(slug: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const orgRow = await this.prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!orgRow) {
      throw new NotFoundException('Organization not found');
    }
    let access;
    try {
      access = await this.authz.requireOrgMember(orgRow.id, userId);
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException('Organization not found');
      }
      throw e;
    }
    const visibleProjectIds = await this.authz.listVisibleProjectIds(orgRow.id, userId);
    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: {
        projects: {
          where: visibleProjectIds === null ? undefined : { id: { in: visibleProjectIds } },
          include: {
            _count: {
              select: {
                deployments: true,
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

    await Promise.all(
      organization.members.map(async (member) => {
        if (!member.user.imageUrl && member.user.hackClubId) {
          const imageUrl = await this.usersService.syncImageUrlFromClerk(member.user.hackClubId);
          if (imageUrl) member.user.imageUrl = imageUrl;
        }
      }),
    );

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId);
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId'],
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      (organization as any).members = organization.members.filter(
        (m) => coMemberIds.has(m.user.id),
      );
    }

    return this.scrubOrgSecrets(organization as any);
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

    if (membership) {
      return membership;
    }

    if (await this.authz.isSuperAdmin(user.id)) {
      return {
        id: `superadmin:${user.id}`,
        organizationId,
        userId: user.id,
        role: 'owner' as const,
        addedAt: new Date(),
        addedBy: null,
      };
    }

    throw new NotFoundException('Organization not found');
  }

  async updateOrganization(
    organizationId: string,
    clerkId: string,
    data: {
      name?: string;
      description?: string;
      backupR2Endpoint?: string | null;
      backupR2Bucket?: string | null;
      backupR2Region?: string | null;
      backupR2AccessKey?: string | null;
      backupR2SecretKey?: string | null;
      databasePublicIp?: string | null;
    },
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const before = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, description: true, backupR2Endpoint: true, backupR2Bucket: true, backupR2Region: true, backupR2AccessKey: true, databasePublicIp: true },
    });

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.backupR2Endpoint !== undefined) updateData.backupR2Endpoint = data.backupR2Endpoint || null;
    if (data.backupR2Bucket !== undefined) updateData.backupR2Bucket = data.backupR2Bucket || null;
    if (data.backupR2Region !== undefined) updateData.backupR2Region = data.backupR2Region || null;
    if (data.backupR2AccessKey !== undefined) updateData.backupR2AccessKey = data.backupR2AccessKey || null;
    if (data.backupR2SecretKey !== undefined) updateData.backupR2SecretKey = data.backupR2SecretKey || null;
    if (data.databasePublicIp !== undefined) {
      const ip = data.databasePublicIp === null ? null : String(data.databasePublicIp).trim() || null;
      if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[0-9a-fA-F:]+$/.test(ip)) {
        throw new BadRequestException('databasePublicIp must be a valid IPv4 or IPv6 address');
      }
      updateData.databasePublicIp = ip;
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: updateData,
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
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

    const changedFields = Object.keys(updateData);
    // Track which secret-bearing fields changed without leaking values.
    const secretFields = ['backupR2SecretKey', 'backupR2AccessKey'];
    const meta: Record<string, any> = {};
    if (before) {
      for (const f of changedFields) {
        if (secretFields.includes(f)) {
          meta[f] = ['***', '***'];
        } else {
          meta[f] = [(before as any)[f] ?? null, (updateData as any)[f] ?? null];
        }
      }
    }
    if (changedFields.length > 0) {
      void this.audit.log({
        action: 'org.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId,
        targetType: 'organization',
        targetId: organizationId,
        targetLabel: updated.name,
        metadata: meta,
      });
    }

    return this.scrubOrgSecrets(updated as any);
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

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { avatarUrl },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
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
    return this.scrubOrgSecrets(updated as any);
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

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { avatarUrl: null },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
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
    return this.scrubOrgSecrets(updated as any);
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

    if (role === 'guest') {
      throw new BadRequestException(
        'Guests cannot be invited directly to an organization — invite them to a specific project instead',
      );
    }

    const inviterAccess = await this.authz.requireOrgAdmin(organizationId, inviter.id);

    // Only owners can invite with the 'owner' role — admins cannot escalate.
    if (role === 'owner' && inviterAccess.role !== 'owner') {
      throw new ForbiddenException('Only organization owners can invite new owners');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const normalizedEmail = email.toLowerCase().trim();

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

      // User exists — add them directly instead of sending an invitation.
      const member = await this.prisma.$transaction(async (tx) => {
        const m = await tx.organizationMember.create({
          data: {
            organizationId,
            userId: existingUser.id,
            role,
            addedBy: inviter.id,
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
              }
            },
            organization: true,
          },
        });

        await tx.organizationInvitation.deleteMany({
          where: { organizationId, email: normalizedEmail },
        });

        return m;
      });

      this.membershipCache.invalidateInternalUserId(existingUser.id);

      void this.audit.log({
        action: 'org.member.added',
        actorUserId: inviter.id,
        actorEmail: inviter.email,
        organizationId,
        targetType: 'user',
        targetId: existingUser.id,
        targetLabel: normalizedEmail,
        metadata: { email: normalizedEmail, role, via: 'direct_add' },
      });

      return member;
    }

    // User doesn't exist yet — send an invitation.
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

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

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

    void this.audit.log({
      action: 'org.member.invited',
      actorUserId: inviter.id,
      actorEmail: inviter.email,
      organizationId,
      targetType: 'invitation',
      targetId: invitation.id,
      targetLabel: normalizedEmail,
      metadata: { email: normalizedEmail, role },
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

    this.membershipCache.invalidateInternalUserId(user.id);

    void this.audit.log({
      action: 'org.member.joined',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: invitation.role, via: 'invitation' },
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

        this.membershipCache.invalidateInternalUserId(user.id);
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

    // Collapse the "not found" and "expired" cases into a single 404. Splitting
    // them gave a holder of an expired token a way to confirm the invitation
    // once existed (and therefore that the org exists) without authentication.
    if (!invitation || invitation.expiresAt < new Date()) {
      throw new NotFoundException('Invitation not found');
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

    try {
      await this.checkPermission(invitation.organizationId, user.id, 'admin');
    } catch {
      throw new NotFoundException('Invitation not found');
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitationId } });

    void this.audit.log({
      action: 'org.invitation.cancelled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'invitation',
      targetId: invitationId,
      targetLabel: invitation.email,
    });

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

    try {
      await this.checkPermission(invitation.organizationId, user.id, 'admin');
    } catch {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

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

    const removerAccess = await this.authz.requireOrgAdmin(organizationId, remover.id);

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

    // Admins are senior to plain members; only owners can remove them. Without
    // this, any admin can boot peer admins (or the entire admin tier) and the
    // sole remaining owner is the only check on org control.
    if (member.role === 'admin' && removerAccess.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can remove an admin');
    }

    // Remove org membership AND all project memberships in this org atomically
    // to prevent stale ProjectMember rows from reactivating if the user is later
    // re-invited (e.g. as a guest — they'd inherit their old project admin roles).
    await this.prisma.$transaction(async (tx) => {
      const adminProjects = await tx.projectMember.findMany({
        where: {
          userId: member.userId,
          project: { organizationId },
          role: { name: 'admin' },
        },
        select: { projectId: true, project: { select: { name: true } } },
      });
      for (const ap of adminProjects) {
        const otherAdmins = await tx.projectMember.count({
          where: {
            projectId: ap.projectId,
            role: { name: 'admin' },
            NOT: { userId: member.userId },
          },
        });
        if (otherAdmins === 0) {
          throw new ConflictException(
            `Cannot remove this member: they are the sole admin of project "${ap.project.name}". Promote another admin first.`,
          );
        }
      }

      await tx.projectMember.deleteMany({
        where: {
          userId: member.userId,
          project: { organizationId },
        },
      });
      await tx.organizationMember.delete({
        where: { id: memberId },
      });
    });

    this.membershipCache.invalidateInternalUserId(member.userId);

    // H4: revoke Tailscale exposure for deployments this user exposed in THIS org.
    // We do NOT delete their global TailscaleConnection (they may still belong to other orgs).
    // Best-effort: failures to remove the k8s sidecar must not block membership removal.
    try {
      const exposed = await this.prisma.deployment.findMany({
        where: {
          tailscaleExposedBy: member.userId,
          tailscaleExposed: true,
          project: { organizationId },
        },
        select: { id: true, name: true, namespace: true },
      });

      for (const dep of exposed) {
        try {
          await this.tailscale.cleanupDeployment({
            id: dep.id,
            name: dep.name,
            namespace: dep.namespace,
            tailscaleExposed: true,
          });
        } catch (err: any) {
          this.logger.warn(
            `H4: failed to remove tailscale sidecar for deployment ${dep.name} in ${dep.namespace}: ${err?.message ?? err}`,
          );
        }
      }

      if (exposed.length > 0) {
        await this.prisma.deployment.updateMany({
          where: {
            id: { in: exposed.map((d) => d.id) },
          },
          data: {
            tailscaleExposed: false,
            tailscaleHostname: null,
            tailscaleExposedBy: null,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `H4: tailscale cleanup on member removal failed (user=${member.userId} org=${organizationId}): ${err?.message ?? err}`,
      );
    }

    void this.audit.log({
      action: 'org.member.removed',
      actorUserId: remover.id,
      actorEmail: remover.email,
      organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email,
      metadata: { role: member.role },
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

    // Guests must have at least one project membership — prevent creating
    // orphaned guests that violate the lifecycle rule.
    if (newRole === 'guest') {
      const projectCount = await this.prisma.projectMember.count({
        where: { userId: member.userId, project: { organizationId } },
      });
      if (projectCount === 0) {
        throw new BadRequestException(
          'Cannot set role to guest: user has no project memberships in this organization. Add them to a project first, or remove them from the org.',
        );
      }
    }

    const updated = await this.prisma.organizationMember.update({
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

    // Invalidate AFTER the write commits. Pre-write invalidation races: a concurrent
    // request can read the OLD role from DB and repopulate the cache during the
    // update window, leaving the user with their previous role for up to the TTL.
    this.membershipCache.invalidateInternalUserId(member.userId);

    void this.audit.log({
      action: 'org.member.role_changed',
      actorUserId: updater.id,
      actorEmail: updater.email,
      organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: updated.user.email,
      metadata: { role: [member.role, newRole] },
    });

    return updated;
  }

}

