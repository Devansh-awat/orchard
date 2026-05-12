import {
  Controller,
  Get,
  Put,
  Delete,
  Patch,
  Post,
  Param,
  Body,
  Request,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SsoService } from './sso.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Auth } from '../auth/decorators';
import { UsersService } from '../users/users.service';

@Auth()
@Controller('organizations')
export class SsoConfigController {
  constructor(
    private readonly ssoService: SsoService,
    private readonly organizationsService: OrganizationsService,
    private readonly usersService: UsersService,
  ) {}

  private async requireEnterprisePlan(organizationId: string, clerkId: string, userData?: any) {
    const org = await this.organizationsService.getOrganization(organizationId, clerkId, userData);
    if (org.plan !== 'enterprise') {
      throw new ForbiddenException('SSO features require an enterprise plan');
    }
    return org;
  }

  private async requireOwner(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    await this.organizationsService.checkPermission(organizationId, user.id, 'owner');
    return user;
  }

  /**
   * Get SSO configuration for an organization.
   * GET /organizations/:id/sso
   */
  @Get(':id/sso')
  async getSsoConfig(
    @Param('id') organizationId: string,
    @Request() req,
  ) {
    await this.requireOwner(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    await this.requireEnterprisePlan(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });

    const config = await this.ssoService.getSsoConfig(organizationId);
    return config || { configured: false };
  }

  /**
   * Create or update SSO configuration.
   * PUT /organizations/:id/sso
   */
  @Put(':id/sso')
  async upsertSsoConfig(
    @Param('id') organizationId: string,
    @Body() body: {
      provider: 'oidc' | 'saml';
      oidcIssuerUrl?: string;
      oidcClientId?: string;
      oidcClientSecret?: string;
      oidcScopes?: string;
      samlEntryPoint?: string;
      samlIssuer?: string;
      samlCertificate?: string;
      samlMetadataUrl?: string;
      loginLogoUrl?: string;
      loginPrimaryColor?: string;
      loginBgColor?: string;
      loginWelcomeText?: string;
      enabled?: boolean;
      enforced?: boolean;
    },
    @Request() req,
  ) {
    await this.requireOwner(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    await this.requireEnterprisePlan(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });

    return this.ssoService.upsertSsoConfig(organizationId, body);
  }

  /**
   * Delete SSO configuration.
   * DELETE /organizations/:id/sso
   */
  @Delete(':id/sso')
  async deleteSsoConfig(
    @Param('id') organizationId: string,
    @Request() req,
  ) {
    await this.requireOwner(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    await this.requireEnterprisePlan(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });

    await this.ssoService.deleteSsoConfig(organizationId);
    return { success: true, message: 'SSO configuration deleted' };
  }

  /**
   * Set or update the organization's custom subdomain.
   * PATCH /organizations/:id/subdomain
   */
  @Patch(':id/subdomain')
  async setSubdomain(
    @Param('id') organizationId: string,
    @Body('subdomain') subdomain: string | null,
    @Request() req,
  ) {
    await this.requireOwner(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    await this.requireEnterprisePlan(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });

    return this.ssoService.setSubdomain(organizationId, subdomain);
  }

  /**
   * Test SSO connection (validates config can reach IdP).
   * POST /organizations/:id/sso/test
   */
  @Post(':id/sso/test')
  async testSsoConnection(
    @Param('id') organizationId: string,
    @Request() req,
  ) {
    await this.requireOwner(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    await this.requireEnterprisePlan(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });

    const config = await this.ssoService.getSsoConfig(organizationId);
    if (!config || config.configured === false) {
      throw new NotFoundException('SSO is not configured');
    }

    // Return a login URL that the admin can use to test
    try {
      const fullConfig = await this.ssoService['prisma'].ssoConfig.findUnique({
        where: { organizationId },
      });

      if (fullConfig.provider === 'oidc') {
        const loginUrl = await this.ssoService.initiateOidcLogin(organizationId);
        return { success: true, testLoginUrl: loginUrl };
      } else if (fullConfig.provider === 'saml') {
        const loginUrl = await this.ssoService.initiateSamlLogin(organizationId);
        return { success: true, testLoginUrl: loginUrl };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to connect to SSO provider',
      };
    }
  }
}
