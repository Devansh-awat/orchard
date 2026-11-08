import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Request
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SsoService } from './sso.service';

/**
 * The organizations a person reaches through an org identity they linked to
 * their account. A link is a shortcut and nothing more: it lists the org in
 * the switcher, and opening it still goes through that org's IdP. Only the
 * account side manages links, so an org can never add itself to someone's
 * account or learn which other orgs they belong to.
 */
@Auth()
@Controller('auth/links')
export class AccountLinksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sso: SsoService
  ) {}

  private accountId(req: any): string {
    if (req.auth?.sessionOrgId || req.auth?.apiTokenId) {
      throw new ForbiddenException('Manage linked organizations from your own account');
    }
    return req.auth.userId;
  }

  @Get()
  async list(@Request() req: any) {
    const accountUserId = this.accountId(req);
    const links = await this.prisma.accountLink.findMany({
      where: { accountUserId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        organization: { select: { id: true, name: true, slug: true, avatarUrl: true } },
        identity: { select: { email: true, disabledAt: true } }
      }
    });
    return Promise.all(
      links.map(async (link) => ({
        id: link.id,
        createdAt: link.createdAt,
        organization: link.organization,
        email: link.identity.email,
        disabled: Boolean(link.identity.disabledAt),
        loginUrl: await this.sso.loginUrlForOrg(link.organization.id)
      }))
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req: any) {
    const accountUserId = this.accountId(req);
    const link = await this.prisma.accountLink.findUnique({ where: { id } });
    if (!link || link.accountUserId !== accountUserId) {
      throw new NotFoundException('Link not found');
    }
    await this.prisma.accountLink.delete({ where: { id } });
    void this.audit.log({
      action: 'account.link.removed',
      actorUserId: accountUserId,
      organizationId: link.organizationId,
      targetType: 'user',
      targetId: link.identityUserId
    });
    return { success: true };
  }
}
