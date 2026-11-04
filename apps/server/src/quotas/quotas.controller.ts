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
  NotFoundException
} from '@nestjs/common';
import { QuotasService } from './quotas.service';
import { QuotaBackfillService } from './backfill.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { podDefaultsFor } from '../kubernetes/presets';
import { Auth, SuperAdmin } from '../auth/decorators';

interface CapBody {
  cpuLimitMilli?: number | null;
  memoryLimitBytes?: number | null;
  maxPods?: number | null;
  maxServices?: number | null;
  defaultPodCpuMilli?: number | null;
  defaultPodMemoryBytes?: number | null;
}

// Super-admin: edit caps on any org.
@SuperAdmin()
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

  // Connect this org's quota pool with another org. Both orgs share caps + usage.
  @Post(':id/quota/connect')
  async connectQuota(@Param('id') id: string, @Body() body: { otherOrgId: string }) {
    return this.quotas.linkOrganizations(id, body.otherOrgId);
  }

  // Disconnect this org from its quota group.
  @Post(':id/quota/disconnect')
  async disconnectQuota(@Param('id') id: string) {
    return this.quotas.unlinkOrganization(id);
  }
}

// Super-admin: backfill resources on pre-existing deployments + databases.
@SuperAdmin()
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
    body: { kind: 'deployment' | 'database'; id: string; cpuMilli: number; memoryBytes: number }
  ) {
    await this.backfill.apply(
      { kind: body.kind, id: body.id },
      { cpuMilli: body.cpuMilli, memoryBytes: body.memoryBytes }
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
    private readonly prisma: PrismaService
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
    @Req() req: any
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });
    if (!project || project.organizationId !== orgId) {
      throw new NotFoundException('Project not found in this organization');
    }
    return this.quotas.updateProjectCaps(projectId, body);
  }

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
    @Req() req: any
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.setMemberAllowance(orgId, userId, body);
  }

  @Patch('default-member-allowance')
  async updateDefaultAllowance(
    @Param('orgId') orgId: string,
    @Body() body: { cpuMilli?: number | null; memoryBytes?: number | null },
    @Req() req: any
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    return this.quotas.setOrgDefaultMemberAllowance(orgId, body);
  }

  @Get('me')
  async getMyUsage(@Param('orgId') orgId: string, @Req() req: any) {
    const userId = req.auth.userId;
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } }
    });
    if (!membership) throw new NotFoundException('Not a member of this org');

    const [allowance, usage, org] = await Promise.all([
      this.quotas.resolveMemberAllowance(orgId, userId),
      this.quotas.getMemberUsage(orgId, userId),
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          cpuLimitMilli: true,
          memoryLimitBytes: true,
          defaultPodCpuMilli: true,
          defaultPodMemoryBytes: true,
          projects: { select: { namespace: true } }
        }
      })
    ]);

    const orgCpuCap = org?.cpuLimitMilli || null;
    const orgMemCap = org?.memoryLimitBytes ? Number(org.memoryLimitBytes) : null;

    const orgUsage =
      orgCpuCap != null || orgMemCap != null
        ? await this.quotas.getOrgTotalUsage(orgId, org?.projects?.map((p) => p.namespace) ?? [])
        : { cpuMilli: 0, memoryBytes: 0 };
    const orgCpuRemaining = orgCpuCap != null ? Math.max(0, orgCpuCap - orgUsage.cpuMilli) : null;
    const orgMemRemaining =
      orgMemCap != null ? Math.max(0, orgMemCap - orgUsage.memoryBytes) : null;

    // Effective limit = min(user allowance, org remaining)
    // If user allowance is null (unlimited), effective = org remaining
    // If org remaining is null (no org cap), effective = user allowance
    // If both null, effective = null (unlimited)
    const userCpu = usage.cpuMilli ?? 0;
    const userMem = usage.memoryBytes ?? 0;

    let effectiveCpuLimit: number | null = null;
    if (allowance.cpuMilli != null && orgCpuRemaining != null) {
      // User has allowance AND org has cap: effective = min(allowance - userUsage, orgRemaining)
      const userLeft = Math.max(0, allowance.cpuMilli - userCpu);
      effectiveCpuLimit = Math.min(userLeft, orgCpuRemaining);
    } else if (allowance.cpuMilli != null) {
      effectiveCpuLimit = Math.max(0, allowance.cpuMilli - userCpu);
    } else if (orgCpuRemaining != null) {
      effectiveCpuLimit = orgCpuRemaining;
    }

    let effectiveMemLimit: number | null = null;
    if (allowance.memoryBytes != null && orgMemRemaining != null) {
      const userLeft = Math.max(0, allowance.memoryBytes - userMem);
      effectiveMemLimit = Math.min(userLeft, orgMemRemaining);
    } else if (allowance.memoryBytes != null) {
      effectiveMemLimit = Math.max(0, allowance.memoryBytes - userMem);
    } else if (orgMemRemaining != null) {
      effectiveMemLimit = orgMemRemaining;
    }

    return {
      allowance,
      usage,
      orgCap: {
        cpuLimitMilli: orgCpuCap,
        memoryLimitBytes: orgMemCap
      },
      /** The max this user can assign to a single new deployment right now */
      effectiveLimit: {
        cpuMilli: effectiveCpuLimit,
        memoryBytes: effectiveMemLimit
      },
      podDefaults: podDefaultsFor({
        defaultPodCpuMilli: org?.defaultPodCpuMilli ?? null,
        defaultPodMemoryBytes: org?.defaultPodMemoryBytes ?? null
      })
    };
  }
}
