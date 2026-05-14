import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Req,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { QuotasService } from './quotas.service';
import { QuotaBackfillService } from './backfill.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { Auth } from '../auth/decorators';
import { NotFoundException } from '@nestjs/common';

type CapBody = {
  cpuLimitMilli?: number | null;
  memoryLimitBytes?: number | null;
  maxPods?: number | null;
  maxServices?: number | null;
  defaultPodCpuMilli?: number | null;
  defaultPodMemoryBytes?: number | null;
};

// Super-admin: edit caps on any org.
@Controller('admin/organizations')
export class AdminQuotasController {
  constructor(private readonly quotas: QuotasService) {}

  @Get(':id/quota')
  async getOrgQuota(@Param('id') id: string) {
    return this.quotas.getOrgUsageWithCaps(id);
  }

  @Patch(':id/quota')
  async updateOrgQuota(@Param('id') id: string, @Body() body: CapBody) {
    return this.quotas.updateOrgCaps(id, body);
  }
}

// Super-admin: backfill resources on pre-existing deployments + databases.
@Controller('admin/backfill')
export class AdminBackfillController {
  constructor(private readonly backfill: QuotaBackfillService) {}

  @Get('candidates')
  async list() {
    return this.backfill.listCandidates();
  }

  @Post('apply')
  async apply(
    @Body()
    body: {
      kind: 'deployment' | 'database';
      id: string;
      cpuMilli: number;
      memoryBytes: number;
    },
  ) {
    await this.backfill.apply(
      { kind: body.kind, id: body.id },
      { cpuMilli: body.cpuMilli, memoryBytes: body.memoryBytes },
    );
    return { success: true };
  }
}

// Org admins: read quotas for their own org, manage per-project overrides.
@Auth()
@Controller('organizations/:orgId/quota')
export class OrgQuotasController {
  constructor(
    private readonly quotas: QuotasService,
    @Inject(forwardRef(() => OrganizationsService))
    private readonly orgs: OrganizationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(@Param('orgId') orgId: string, @Req() req: any) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.getOrgUsageWithCaps(orgId);
  }

  @Get('projects')
  async listProjectCaps(@Param('orgId') orgId: string, @Req() req: any) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.listProjectCapsForOrg(orgId);
  }

  @Patch('projects/:projectId')
  async updateProjectCaps(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: CapBody,
    @Req() req: any,
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    });
    if (!project || project.organizationId !== orgId) {
      throw new NotFoundException('Project not found in this organization');
    }
    return this.quotas.updateProjectCaps(projectId, body);
  }

  // --- Per-member allowance ---

  @Get('members')
  async listMembersUsage(@Param('orgId') orgId: string, @Req() req: any) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.getOrgMembersUsage(orgId);
  }

  @Patch('members/:userId')
  async updateMemberAllowance(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Body()
    body: {
      cpuMilli?: number | null;
      memoryBytes?: number | null;
      cpuUnlimited?: boolean;
      memoryUnlimited?: boolean;
    },
    @Req() req: any,
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.setMemberAllowance(orgId, userId, body);
  }

  @Patch('default-member-allowance')
  async updateDefaultAllowance(
    @Param('orgId') orgId: string,
    @Body() body: { cpuMilli?: number | null; memoryBytes?: number | null },
    @Req() req: any,
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.setOrgDefaultMemberAllowance(orgId, body);
  }

  @Get('me')
  async getMyUsage(@Param('orgId') orgId: string, @Req() req: any) {
    const userId = req.auth.userId;
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
    });
    if (!membership) throw new NotFoundException('Not a member of this org');
    const allowance = await this.quotas.resolveMemberAllowance(orgId, userId);
    const usage = await this.quotas.getMemberUsage(orgId, userId);
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { cpuLimitMilli: true, memoryLimitBytes: true },
    });
    return {
      allowance,
      usage,
      orgCap: {
        cpuLimitMilli: org?.cpuLimitMilli ?? null,
        memoryLimitBytes: org?.memoryLimitBytes ? Number(org.memoryLimitBytes) : null,
      },
    };
  }
}
