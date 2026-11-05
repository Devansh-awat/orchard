import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth } from '@orchardlabs/graft-sdk/server';
import { requestAuthStorage } from '../../core/request-context';
import { UsersService } from '../../core/users.service';
import { AnalyticsService } from '../../core/analytics.service';
import { SandboxEnabledGuard } from '../sandbox-enabled.guard';
import { SandboxAccessService } from '../sandbox-access.service';
import { requireSandboxAccess } from '../sandbox-role-gate';
import { GreenhouseIssuesService } from './greenhouse-issues.service';
import { SlackLinkService } from './slack-link.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller()
export class IntegrationsController {
  constructor(
    private readonly issues: GreenhouseIssuesService,
    private readonly slackLinks: SlackLinkService,
    private readonly accessService: SandboxAccessService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private async resolveUser(req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    return user;
  }

  private requireAccountSession(opts: { refuseApiTokens?: boolean } = {}) {
    const ctx = requestAuthStorage.getStore();
    if (
      ctx?.sessionOrgId ||
      ctx?.tokenProjectIds?.length ||
      (opts.refuseApiTokens && (ctx?.apiTokenId || ctx?.mcpGateway))
    ) {
      throw new ForbiddenException('Manage linked accounts from a regular Orchard session');
    }
  }

  @Get('users/me/integrations')
  async linked(@Req() req: any) {
    const user = await this.resolveUser(req);
    return this.issues.linkedIntegrations(user.id);
  }

  @Post('integrations/slack/link/preview')
  async previewSlackLink(@Req() req: any, @Body() body: { token?: unknown }) {
    this.requireAccountSession({ refuseApiTokens: true });
    await this.resolveUser(req);
    return this.slackLinks.preview(body?.token);
  }

  @Post('integrations/slack/link')
  async linkSlack(@Req() req: any, @Body() body: { token?: unknown }) {
    this.requireAccountSession({ refuseApiTokens: true });
    const user = await this.resolveUser(req);
    return this.slackLinks.confirm(user.id, body?.token);
  }

  @Delete('users/me/integrations/slack')
  async unlinkSlack(@Req() req: any) {
    this.requireAccountSession();
    const user = await this.resolveUser(req);
    return this.slackLinks.unlinkUser(user.id);
  }

  @Get('users/me/integrations/linear')
  async linearStatus(@Req() req: any) {
    this.requireAccountSession();
    const user = await this.resolveUser(req);
    return this.issues.linearStatus(user.id);
  }

  @Put('users/me/integrations/linear')
  async connectLinear(@Req() req: any, @Body() body: { apiKey?: unknown }) {
    this.requireAccountSession({ refuseApiTokens: true });
    const user = await this.resolveUser(req);
    return this.issues.connectLinear(user.id, body?.apiKey);
  }

  @Delete('users/me/integrations/linear')
  async disconnectLinear(@Req() req: any) {
    this.requireAccountSession();
    const user = await this.resolveUser(req);
    return this.issues.disconnectLinear(user.id);
  }

  @Get('integrations/linear/issues')
  async linearIssues(@Req() req: any, @Query('q') q?: string) {
    this.requireAccountSession();
    const user = await this.resolveUser(req);
    return this.issues.linearIssues(user.id, q);
  }

  @Get('sandboxes/:id/issues')
  async sandboxIssues(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('provider') provider?: string,
    @Query('repo') repo?: string,
    @Query('q') q?: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.accessService, id, user.id, 'collaborator');
    if (provider === 'linear') {
      const result = await this.issues.linearIssues(user.id, q);
      return { repo: null, ...result };
    }
    if (provider !== undefined && provider !== 'github') {
      throw new BadRequestException("provider must be 'github' or 'linear'");
    }
    return this.issues.githubIssuesFor(row, user.id, repo, q);
  }
}
