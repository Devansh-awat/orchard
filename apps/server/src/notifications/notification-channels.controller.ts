import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService, ChannelInput } from './notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('organizations')
export class NotificationChannelsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly organizationsService: OrganizationsService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
  ) {}

  private async requireAdmin(organizationId: string, req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    if (!user) throw new NotFoundException('User not found');
    await this.organizationsService.checkPermission(organizationId, user.id, 'admin');
    return user;
  }

  private async requireNotificationsFeature(userId: string): Promise<void> {
    const enabled = await this.analytics.isFeatureEnabled('notifications', userId);
    if (!enabled) {
      throw new ForbiddenException('Notifications are not enabled for your account. Enable the Notifications beta in Early Access Features.');
    }
  }

  @Get(':id/notification-channels')
  async listChannels(@Param('id') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    return this.notifications.listChannels(organizationId);
  }

  @Post(':id/notification-channels')
  async createChannel(
    @Param('id') organizationId: string,
    @Body() body: ChannelInput,
    @Request() req,
  ) {
    const user = await this.requireAdmin(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.notifications.createChannel(organizationId, body ?? {}, user);
  }

  @Patch(':id/notification-channels/:channelId')
  async updateChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Body() body: ChannelInput,
    @Request() req,
  ) {
    const user = await this.requireAdmin(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.notifications.updateChannel(organizationId, channelId, body ?? {}, user);
  }

  @Delete(':id/notification-channels/:channelId')
  async deleteChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req,
  ) {
    const user = await this.requireAdmin(organizationId, req);
    return this.notifications.deleteChannel(organizationId, channelId, user);
  }

  @Get(':id/notification-channels/:channelId/deliveries')
  async listDeliveries(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req,
  ) {
    await this.requireAdmin(organizationId, req);
    return this.notifications.listDeliveries(organizationId, channelId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post(':id/notification-channels/:channelId/test')
  async testChannel(
    @Param('id') organizationId: string,
    @Param('channelId') channelId: string,
    @Request() req,
  ) {
    const user = await this.requireAdmin(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.notifications.testChannel(organizationId, channelId);
  }
}
