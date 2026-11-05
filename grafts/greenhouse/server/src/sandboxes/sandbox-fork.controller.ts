import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Auth, RequireScope } from '@orchardlabs/graft-sdk/server';
import { UsersService } from '../core/users.service';
import { AnalyticsService } from '../core/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxForkService } from './sandbox-fork.service';
import { resolveGreenhouseUser } from './sandbox-greenhouse-user';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxForkController {
  constructor(
    private readonly access: SandboxAccessService,
    private readonly forks: SandboxForkService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  @Post(':id/fork')
  @RequireScope('exec')
  async fork(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string }
  ) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner');
    return this.forks.fork(access, user.email ?? null, body || {});
  }
}
