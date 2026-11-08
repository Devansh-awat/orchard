import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { MemberSource, OrganizationRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { sanitizeUsername } from '../users/users.service';
import { identityEmail } from '../users/account-scope';

export const DEFAULT_ORG_IDENTITY_CAP = 20_000;

export interface OrgIdentityInput {
  email: string;
  name: string;
  role: OrganizationRole;
  source: MemberSource;
}

/**
 * Members an organization owns outright: provisioned by its IdP or SCIM,
 * confined to it, and never an account anyone signs in to any other way. The
 * email lives in the org's own namespace (emailScope = org id), so it can
 * repeat an address that also has a personal account, or one another org
 * provisioned, without either ever resolving to the other.
 */
@Injectable()
export class OrgIdentityService {
  private readonly logger = new Logger(OrgIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  cap(): number {
    const raw = Number(process.env.ORG_IDENTITY_CAP);
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ORG_IDENTITY_CAP;
  }

  findByEmail(organizationId: string, email: string) {
    return this.prisma.user.findUnique({ where: identityEmail(organizationId, email) });
  }

  async create(
    organizationId: string,
    input: OrgIdentityInput,
    actorLabel: string,
    member: Partial<Prisma.OrganizationMemberUncheckedCreateInput> = {}
  ) {
    if (input.role === OrganizationRole.owner) {
      throw new ForbiddenException("An identity provider can't create an owner");
    }
    const count = await this.prisma.user.count({ where: { homeOrganizationId: organizationId } });
    if (count >= this.cap()) {
      this.logger.warn(`Org ${organizationId} hit the identity cap (${this.cap()})`);
      throw new ForbiddenException('This organization has reached its member limit');
    }
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { slug: true }
    });
    const username = await this.uniqueUsername(input.email, organization.slug);
    const parts = (input.name || '').trim().split(/\s+/);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          emailScope: organizationId,
          homeOrganizationId: organizationId,
          username,
          firstName: parts[0] || null,
          lastName: parts.slice(1).join(' ') || null,
          setupCompleted: true
        }
      });
      await tx.organizationMember.create({
        data: {
          ...member,
          organizationId,
          userId: created.id,
          role: input.role,
          source: input.source
        }
      });
      return created;
    });

    void this.audit.log({
      action: 'org.identity.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: input.role, source: input.source, via: actorLabel }
    });
    return user;
  }

  /**
   * Usernames are global, so an org's people get a suffix with the org's slug.
   * An org can then never take a bare handle like "admin" or someone's name.
   */
  private async uniqueUsername(email: string, orgSlug: string): Promise<string> {
    const suffix = `-${sanitizeUsername(orgSlug).slice(0, 40)}`;
    const base = sanitizeUsername(email.split('@')[0]).slice(0, 100 - suffix.length - 6);
    let username = `${base}${suffix}`;
    for (let n = 1; await this.prisma.user.findUnique({ where: { username } }); n += 1) {
      username = `${base}${n}${suffix}`;
    }
    return username;
  }
}
