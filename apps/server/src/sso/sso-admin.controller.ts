import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
  NotFoundException,
} from '@nestjs/common';
import { SsoService, ProviderInput, SettingsInput } from './sso.service';
import { SsoLoginService } from './sso-login.service';
import { publicPresets } from './presets';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';

/**
 * Org-owned SSO configuration. Owners and org admins manage it; the platform
 * superadmin's kill switch lives in sso-instance.controller and is not
 * reachable from here.
 */
@Auth()
@Controller('organizations/:id/sso')
export class SsoAdminController {
  constructor(
    private readonly sso: SsoService,
    private readonly login: SsoLoginService,
    private readonly authz: AuthorizationService,
    private readonly users: UsersService,
  ) {}

  private async requireAdmin(organizationId: string, req: any) {
    const user = await this.users.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireOrgAdmin(organizationId, user.id);
    return { userId: user.id, email: user.email as string };
  }

  /** The whole tab in one request: posture, connections, and the catalogue. */
  @Get()
  async overview(@Param('id') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    const [settings, providers] = await Promise.all([
      this.sso.getSettings(organizationId),
      this.sso.listProviders(organizationId),
    ]);
    return {
      settings,
      providers,
      presets: publicPresets(),
      loginUrl: await this.sso.loginUrlForOrg(organizationId),
    };
  }

  @Patch('settings')
  async updateSettings(
    @Param('id') organizationId: string,
    @Body() body: SettingsInput,
    @Request() req,
  ) {
    const actor = await this.requireAdmin(organizationId, req);
    return this.sso.updateSettings(organizationId, body, actor);
  }

  @Get('providers')
  async listProviders(@Param('id') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    return this.sso.listProviders(organizationId);
  }

  @Post('providers')
  async createProvider(
    @Param('id') organizationId: string,
    @Body() body: ProviderInput,
    @Request() req,
  ) {
    const actor = await this.requireAdmin(organizationId, req);
    return this.sso.createProvider(organizationId, body, actor);
  }

  @Get('providers/:providerId')
  async getProvider(
    @Param('id') organizationId: string,
    @Param('providerId') providerId: string,
    @Request() req,
  ) {
    await this.requireAdmin(organizationId, req);
    return this.sso.getProviderForAdmin(providerId, organizationId);
  }

  @Patch('providers/:providerId')
  async updateProvider(
    @Param('id') organizationId: string,
    @Param('providerId') providerId: string,
    @Body() body: ProviderInput,
    @Request() req,
  ) {
    const actor = await this.requireAdmin(organizationId, req);
    return this.sso.updateProvider(providerId, organizationId, body, actor);
  }

  @Delete('providers/:providerId')
  async deleteProvider(
    @Param('id') organizationId: string,
    @Param('providerId') providerId: string,
    @Request() req,
  ) {
    const actor = await this.requireAdmin(organizationId, req);
    return this.sso.deleteProvider(providerId, organizationId, actor);
  }

  @Post('providers/:providerId/test')
  async testProvider(
    @Param('id') organizationId: string,
    @Param('providerId') providerId: string,
    @Request() req,
  ) {
    await this.requireAdmin(organizationId, req);
    // Scope check first: testing a provider id from another org must 404.
    await this.sso.getProviderForAdmin(providerId, organizationId);
    return this.login.testProvider(providerId);
  }
}
