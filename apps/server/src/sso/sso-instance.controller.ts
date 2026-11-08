import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Request,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SsoService, ProviderInput } from './sso.service';
import { SsoLoginService } from './sso-login.service';
import { IdentityMappingService, RulesInput } from './identity-mapping.service';
import { publicPresets } from './presets';
import { assertProviderIcon, PROVIDER_ICON_UPLOAD } from './provider-icon';
import { ImageUploadSlots } from '../http/upload-limits';

/**
 * Instance-wide SSO. Superadmin-only by default-deny: no @Auth()/@SuperAdmin()
 * decorator here means the global SuperAdminGuard applies.
 *
 * Two jobs. Providers with no organization are the platform's own sign-in
 * options. The per-org toggle is the operator's switch for one tenant, and an
 * org owner cannot turn it back on from inside their settings.
 */
@Controller('admin/sso')
export class SsoInstanceController {
  constructor(
    private readonly sso: SsoService,
    private readonly login: SsoLoginService,
    private readonly mapping: IdentityMappingService
  ) {}

  private actor(req: any) {
    return { userId: req.user?.sub as string, email: req.user?.email as string | undefined };
  }

  @Get()
  async overview() {
    const [providers, organizations, enforcement] = await Promise.all([
      this.sso.listProviders(null),
      this.sso.getPlatformStatuses(),
      this.sso.getInstanceEnforcement()
    ]);
    return {
      providers,
      organizations,
      enforcement,
      presets: publicPresets(),
      envProvider: this.sso.envProvider()
    };
  }

  @Get('enforcement')
  enforcement() {
    return this.sso.getInstanceEnforcement();
  }

  @Patch('enforcement')
  setEnforcement(@Body('enabled') enabled: boolean, @Request() req) {
    return this.sso.setInstanceEnforced(Boolean(enabled), this.actor(req));
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
    @Request() req
  ) {
    return this.sso.updateProvider(providerId, null, body, this.actor(req));
  }

  @Delete('providers/:providerId')
  deleteProvider(@Param('providerId') providerId: string, @Request() req) {
    return this.sso.deleteProvider(providerId, null, this.actor(req));
  }

  @Post('providers/:providerId/icon')
  @UseInterceptors(ImageUploadSlots, FileInterceptor('file', PROVIDER_ICON_UPLOAD))
  uploadProviderIcon(
    @Param('providerId') providerId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    return this.sso.uploadProviderIcon(providerId, null, assertProviderIcon(file), this.actor(req));
  }

  @Delete('providers/:providerId/icon')
  removeProviderIcon(@Param('providerId') providerId: string, @Request() req) {
    return this.sso.removeProviderIcon(providerId, null, this.actor(req));
  }

  @Get('providers/:providerId/rules')
  async listRules(@Param('providerId') providerId: string) {
    return this.mapping.listRules(await this.mapping.requireProvider(providerId, null));
  }

  @Put('providers/:providerId/rules')
  async replaceRules(
    @Param('providerId') providerId: string,
    @Body() body: RulesInput,
    @Request() req
  ) {
    const provider = await this.mapping.requireProvider(providerId, null);
    return this.mapping.replaceRules(provider, body, this.actor(req));
  }

  @Post('providers/:providerId/rules/preview')
  async previewRules(@Param('providerId') providerId: string, @Body('groups') groups: string[]) {
    return this.mapping.preview(await this.mapping.requireProvider(providerId, null), groups);
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
    @Request() req
  ) {
    return this.sso.setPlatformEnabled(organizationId, Boolean(platformEnabled), this.actor(req));
  }
}
