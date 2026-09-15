import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Request,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationChannelsService, ChannelInput } from './notification-channels.service';
import { NotificationRulesService, RuleInput } from './notification-rules.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthorizationService } from '../auth/authorization.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('organizations')
export class NotificationChannelsController {
  constructor(
    private readonly channels: NotificationChannelsService,
    private readonly rules: NotificationRulesService,
    private readonly organizationsService: OrganizationsService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
    private readonly authz: AuthorizationService
  ) {}

  private async currentUser(req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async requireAdmin(organizationId: string, req: any) {
    const user = await this.currentUser(req);
    await this.organizationsService.checkPermission(organizationId, user.id, 'admin');
    return user;
  }

  // Rules at a project or resource scope only need membership of that scope, so
  // this stops at "are you in the org" and leaves the finer check to the service.
  private async requireMember(organizationId: string, req: any) {
    const user = await this.currentUser(req);
    await this.authz.requireOrgMember(organizationId, user.id);
    return user;
  }

  // A destination is gated by the scope that owns it: the org's shared webhook
  // still needs an org admin, one an app owns needs admin on that app's project.
  private async requireChannelScope(organizationId: string, channelId: string, req: any) {
    const user = await this.requireMember(organizationId, req);
    const channel = await this.channels.findChannelScope(organizationId, channelId);
    const scope = await this.rules.resolveScope(organizationId, channel.scopeType, channel.scopeId);
    await this.rules.assertCanEditScope(organizationId, scope, user);
    return { user, scope };
  }

  private async requireNotificationsFeature(userId: string): Promise<void> {
    const enabled = await this.analytics.isFeatureEnabled('notifications', userId);
    if (!enabled) {
      throw new ForbiddenException(
        'Notifications are not enabled for your account. Enable the Notifications beta in Early Access Features.'
      );
    }
  }

  // Without a scope this is the org admin's inventory, webhook previews and all.
  // With one it answers the narrower question the app settings page asks: what
  // may this app route to, and which of those does it own.
  @Get(':id/notification-channels')
  async listChannels(
    @Param('id') organizationId: string,
    @Query('scopeType') scopeType: string,
    @Query('scopeId') scopeId: string,
    @Request() req
  ) {
    if (scopeType) {
      await this.requireMember(organizationId, req);
      const scope = await this.rules.resolveScope(organizationId, scopeType, scopeId ?? null);
      return this.channels.listChannelsForScope(organizationId, scope);
    }
    await this.requireAdmin(organizationId, req);
    return this.channels.listChannels(organizationId);
  }

  @Post(':id/notification-channels')
  async createChannel(
    @Param('id') organizationId: string,
    @Body() body: ChannelInput,
    @Request() req
  ) {
    const user = await this.requireMember(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    const scope = await this.rules.resolveScope(
      organizationId,
      body?.scopeType ?? 'org',
      body?.scopeId ?? null
    );
    await this.rules.assertCanEditScope(organizationId, scope, user);
    return this.channels.createChannel(organizationId, body ?? {}, user, scope);
  }

  @Patch(':id/notification-channels/:channelId')
  async updateChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelInput,
    @Request() req
  ) {
    const { user, scope } = await this.requireChannelScope(organizationId, channelId, req);
    await this.requireNotificationsFeature(user.id);
    return this.channels.updateChannel(organizationId, channelId, body ?? {}, user, scope);
  }

  @Delete(':id/notification-channels/:channelId')
  async deleteChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req
  ) {
    const { user } = await this.requireChannelScope(organizationId, channelId, req);
    return this.channels.deleteChannel(organizationId, channelId, user);
  }

  @Get(':id/notification-channels/:channelId/deliveries')
  async listDeliveries(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req
  ) {
    await this.requireChannelScope(organizationId, channelId, req);
    return this.channels.listDeliveries(organizationId, channelId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post(':id/notification-channels/:channelId/test')
  async testChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req
  ) {
    const { user } = await this.requireChannelScope(organizationId, channelId, req);
    await this.requireNotificationsFeature(user.id);
    return this.channels.testChannel(organizationId, channelId);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post(':id/notification-channels/:channelId/replay')
  async replayChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Body() body: { sinceHours?: number },
    @Request() req
  ) {
    const { user } = await this.requireChannelScope(organizationId, channelId, req);
    await this.requireNotificationsFeature(user.id);
    return this.channels.replay(organizationId, channelId, body?.sinceHours ?? 24, user);
  }

  @Get(':id/notification-rules')
  async listRules(
    @Param('id') organizationId: string,
    @Query('scopeType') scopeType: string,
    @Query('scopeId') scopeId: string,
    @Request() req
  ) {
    await this.requireMember(organizationId, req);
    return this.rules.listRules(organizationId, scopeType, scopeId);
  }

  @Post(':id/notification-rules')
  async createRule(@Param('id') organizationId: string, @Body() body: RuleInput, @Request() req) {
    const user = await this.requireMember(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.rules.createRule(organizationId, body ?? {}, user);
  }

  @Patch(':id/notification-rules/:ruleId')
  async updateRule(
    @Param('id') organizationId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: RuleInput,
    @Request() req
  ) {
    const user = await this.requireMember(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.rules.updateRule(organizationId, ruleId, body ?? {}, user);
  }

  @Delete(':id/notification-rules/:ruleId')
  async deleteRule(
    @Param('id') organizationId: string,
    @Param('ruleId') ruleId: string,
    @Request() req
  ) {
    const user = await this.requireMember(organizationId, req);
    return this.rules.deleteRule(organizationId, ruleId, user);
  }
}
