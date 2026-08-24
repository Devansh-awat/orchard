import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
} from '@nestjs/common';
import { SsoService, ProviderInput } from './sso.service';
import { SsoLoginService } from './sso-login.service';
import { publicPresets } from './presets';

/**
 * Instance-wide SSO. Superadmin-only by default-deny: no @Auth()/@SuperAdmin()
 * decorator here means the global SuperAdminGuard applies.
 *
 * Two jobs. Providers with no organization are the platform's own sign-in
 * options, which is what replaced the hardcoded single OAuth button. The
 * per-org toggle is the operator's switch for one tenant, and an org owner
 * cannot turn it back on from inside their settings.
 */
@Controller('admin/sso')
export class SsoInstanceController {
  constructor(
    private readonly sso: SsoService,
    private readonly login: SsoLoginService,
  ) {}

  private actor(req: any) {
    return { userId: req.user?.sub as string, email: req.user?.email as string | undefined };
  }

  @Get()
  async overview() {
    const [providers, organizations] = await Promise.all([
      this.sso.listProviders(null),
      this.sso.getPlatformStatuses(),
    ]);
    return {
      providers,
      organizations,
      presets: publicPresets(),
      envProvider: this.sso.envProvider(),
    };
  }

  @Get('providers')
  listProviders() {
    return this.sso.listProviders(null);
  }

  @Post('providers')
  createProvider(@Body() body: ProviderInput, @Request() req) {
    return this.sso.createProvider(null, body, this.actor(req));
  }

  @Get('providers/:providerId')
  getProvider(@Param('providerId') providerId: string) {
    return this.sso.getProviderForAdmin(providerId, null);
  }

  @Patch('providers/:providerId')
  updateProvider(
    @Param('providerId') providerId: string,
    @Body() body: ProviderInput,
    @Request() req,
  ) {
    return this.sso.updateProvider(providerId, null, body, this.actor(req));
  }

  @Delete('providers/:providerId')
  deleteProvider(@Param('providerId') providerId: string, @Request() req) {
    return this.sso.deleteProvider(providerId, null, this.actor(req));
  }

  @Post('providers/:providerId/test')
  async testProvider(@Param('providerId') providerId: string) {
    await this.sso.getProviderForAdmin(providerId, null);
    return this.login.testProvider(providerId);
  }

  @Get('organizations')
  organizations() {
    return this.sso.getPlatformStatuses();
  }

  @Patch('organizations/:organizationId')
  setPlatformEnabled(
    @Param('organizationId') organizationId: string,
    @Body('platformEnabled') platformEnabled: boolean,
    @Request() req,
  ) {
    return this.sso.setPlatformEnabled(organizationId, Boolean(platformEnabled), this.actor(req));
  }
}
