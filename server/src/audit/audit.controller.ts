import { Controller, Get, Param, Query, Req, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { Auth } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { AuthorizationService } from '../auth/authorization.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Auth()
@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
  ) {}

  // Superadmin-only global ledger.
  @Get('global')
  async getGlobal(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
  ) {
    const userId = await this.resolveUserId(req);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Superadmin access required');
    }
    return this.auditService.query({
      scope: { kind: 'global' },
      cursor: cursor || null,
      limit: limit ? parseInt(limit, 10) : undefined,
      action,
    });
  }

  // Org-scoped ledger. Visible to org admins/owners.
  @Get('organization/:id')
  async getOrgLogs(
    @Param('id') organizationId: string,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
  ) {
    const userId = await this.resolveUserId(req);
    await this.authz.requireOrgAdmin(organizationId, userId);
    return this.auditService.query({
      scope: { kind: 'organization', organizationId },
      cursor: cursor || null,
      limit: limit ? parseInt(limit, 10) : undefined,
      action,
    });
  }

  // Deployment-scoped ledger. Visible to project members.
  @Get('deployment/:id')
  async getDeploymentLogs(
    @Param('id') deploymentId: string,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
  ) {
    const userId = await this.resolveUserId(req);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');

    await this.authz.requireProjectView(deployment.projectId, userId);

    return this.auditService.query({
      scope: { kind: 'deployment', deploymentId },
      cursor: cursor || null,
      limit: limit ? parseInt(limit, 10) : undefined,
      action,
    });
  }

  private async resolveUserId(req: Request): Promise<string> {
    const sub = (req as any).user?.sub as string | undefined;
    if (!sub) throw new ForbiddenException('Not authenticated');
    if (UUID_RE.test(sub)) return sub;
    const user = await this.prisma.user.findFirst({ where: { hackClubId: sub }, select: { id: true } });
    if (!user) throw new ForbiddenException('User not found');
    return user.id;
  }
}
