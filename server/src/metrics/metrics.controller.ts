import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('organizations/:orgId/metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly orgs: OrganizationsService,
  ) {}

  @Get('provisioning')
  async getProvisioning(
    @Param('orgId') orgId: string,
    @Query('range') rangeRaw: string | undefined,
    @Req() req: any,
  ) {
    await this.orgs.checkPermission(orgId, req.auth.userId, 'admin');
    const rangeSeconds = parseRange(rangeRaw) ?? 24 * 3600;
    return this.metrics.getOrgActualVsProvisioned(orgId, rangeSeconds);
  }
}

function parseRange(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return n * mult;
}
