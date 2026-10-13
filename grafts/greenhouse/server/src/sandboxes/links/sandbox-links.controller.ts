import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth, RequireScope } from '@orchard/graft-sdk/server';
import { UsersService } from '../../core/users.service';
import { AnalyticsService } from '../../core/analytics.service';
import { SandboxEnabledGuard } from '../sandbox-enabled.guard';
import { SandboxAccessService } from '../sandbox-access.service';
import { requireSandboxAccess, type SandboxAccessLevel } from '../sandbox-role-gate';
import { SandboxProjectLinksService } from './sandbox-project-links.service';
import { SandboxPreviewDeployService } from './sandbox-preview-deploy.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxLinksController {
  constructor(
    private readonly accessService: SandboxAccessService,
    private readonly links: SandboxProjectLinksService,
    private readonly previews: SandboxPreviewDeployService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private async access(req: any, id: string, level: SandboxAccessLevel) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    const row = await requireSandboxAccess(this.accessService, id, user.id, level);
    return { user, row };
  }

  private actor(req: any, user: { id: string; email?: string | null }) {
    return {
      id: user.id,
      email: user.email ?? null,
      clerkId: req.user.externalAuthId || req.user.sub
    };
  }

  @Get(':id/links')
  async list(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { row } = await this.access(req, id, 'viewer');
    return this.links.list(row);
  }

  @Post(':id/links')
  @RequireScope('exec')
  async attach(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { projectId?: string; environmentId?: string | null }
  ) {
    const { user, row } = await this.access(req, id, 'owner');
    return this.links.attach(row, this.actor(req, user), body ?? {});
  }

  @Delete(':id/links/:projectId')
  @RequireScope('exec')
  async detach(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('projectId', ParseUUIDPipe) projectId: string
  ) {
    const { user, row } = await this.access(req, id, 'owner');
    return this.links.detach(row, this.actor(req, user), projectId);
  }

  @Post(':id/sessions/:sid/preview-deploy')
  @RequireScope('deploy')
  async previewDeploy(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { projectId?: string; deploymentId?: string | null }
  ) {
    const { user, row } = await this.access(req, id, 'owner');
    return this.previews.deploy(row, sid, this.actor(req, user), body ?? {});
  }

  @Delete(':id/sessions/:sid/preview-deploy')
  @RequireScope('deploy')
  async previewRemove(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { user, row } = await this.access(req, id, 'owner');
    return this.previews.remove(row, sid, this.actor(req, user));
  }
}
