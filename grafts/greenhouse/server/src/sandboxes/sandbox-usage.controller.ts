import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { Auth, RequireScope } from '@orchard/graft-sdk/server';
import { UsersService } from '../core/users.service';
import { AnalyticsService } from '../core/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxUsageService } from './sandbox-usage.service';
import { resolveGreenhouseUser } from './sandbox-greenhouse-user';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxUsageController {
  constructor(
    private readonly access: SandboxAccessService,
    private readonly usageService: SandboxUsageService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  @Get(':id/usage')
  @RequireScope('read')
  async usage(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const access = await this.access.requireSandboxRole(id, user.id, 'viewer', { orgAdmin: true });
    return this.usageService.forSandbox(access.sandbox);
  }
}
