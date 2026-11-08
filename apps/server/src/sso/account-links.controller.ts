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
