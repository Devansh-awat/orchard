import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth, RequireScope } from '@orchardlabs/graft-sdk/server';
import { UsersService } from '../core/users.service';
import { AnalyticsService } from '../core/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxAgentService } from './sandbox-agent.service';
import { SandboxAgentUsageService } from './sandbox-agent-usage.service';
import { requireSandboxAccess } from './sandbox-role-gate';
import { resolveGreenhouseUser } from './sandbox-greenhouse-user';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxAgentController {
  constructor(
    private readonly access: SandboxAccessService,
    private readonly agent: SandboxAgentService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
    private readonly usageService: SandboxAgentUsageService
  ) {}

  @Post(':id/sessions/:sid/prompt')
  @RequireScope('exec')
  async prompt(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { text?: string }
  ) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.agent.prompt(row, sid, user.id, body?.text);
  }

  @Get(':id/sessions/:sid/transcript')
  @RequireScope('exec')
  async transcript(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('limit') limit?: string
  ) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.agent.transcript(row, sid, { limit });
  }

  @Get(':id/agent/usage')
  @RequireScope('read')
  async usage(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.usageService.forSandbox(row, user.id);
  }
}
