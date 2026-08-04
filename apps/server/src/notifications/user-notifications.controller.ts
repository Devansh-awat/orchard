import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Request,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserNotificationsService, DestinationInput, SettingsInput } from './user-notifications.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { Auth } from '../auth/decorators';

// Everything here acts on the caller's own rows. There is deliberately no way
// to read or write another person's notification settings, the same guarantee
// Vercel makes: changes only ever affect your own notifications.
@Auth()
@Controller('users/me')
export class UserNotificationsController {
  constructor(
    private readonly notifications: UserNotificationsService,
    private readonly usersService: UsersService,
    private readonly authz: AuthorizationService,
  ) {}

  private async currentUser(req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Get('notification-settings')
  async getSettings(@Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.getSettings(user.id);
  }

  @Put('notification-settings')
  async setGlobalSettings(@Body() body: SettingsInput, @Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.setSettings(user.id, 'global', null, body ?? {});
  }

  @Get('notification-settings/:scopeType/:scopeId')
  async getScopeSettings(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Query('organizationId') organizationId: string,
    @Request() req,
  ) {
    const user = await this.currentUser(req);
    await this.authz.requireOrgMember(organizationId, user.id);
    return this.notifications.getScopeSettings(user.id, organizationId, scopeType, scopeId);
  }

  @Put('notification-settings/:scopeType/:scopeId')
  async setScopeSettings(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Body() body: SettingsInput & { organizationId?: string },
    @Request() req,
  ) {
    const user = await this.currentUser(req);
    const organizationId = body?.organizationId ?? '';
    await this.authz.requireOrgMember(organizationId, user.id);
    return this.notifications.setSettings(user.id, scopeType, scopeId, body ?? {}, organizationId);
  }

  @Delete('notification-settings/:scopeType/:scopeId')
  async clearScopeSettings(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Request() req,
  ) {
    const user = await this.currentUser(req);
    return this.notifications.clearScopeSettings(user.id, scopeType, scopeId);
  }

  @Get('notification-destinations')
  async listDestinations(@Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.listDestinations(user.id);
  }

  @Post('notification-destinations')
  async addDestination(@Body() body: DestinationInput, @Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.addDestination(user.id, body ?? {});
  }

  @Put('notification-destinations/:destinationId')
  async setDestinationEnabled(
    @Param('destinationId') destinationId: string,
    @Body() body: { enabled?: boolean },
    @Request() req,
  ) {
    const user = await this.currentUser(req);
    return this.notifications.setDestinationEnabled(user.id, destinationId, body?.enabled !== false);
  }

  @Delete('notification-destinations/:destinationId')
  async deleteDestination(@Param('destinationId') destinationId: string, @Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.deleteDestination(user.id, destinationId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('notification-destinations/:destinationId/test')
  async testDestination(@Param('destinationId') destinationId: string, @Request() req) {
    const user = await this.currentUser(req);
    return this.notifications.testDestination(user.id, destinationId);
  }
}
