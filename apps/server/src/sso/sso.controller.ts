import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SsoService } from './sso.service';
import { Public } from '../auth/decorators';
import { setSessionCookie } from '../auth/cookies';

@Public()
@Controller('sso')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  // H-2: cookie attributes come from ../auth/cookies — shared across OAuth,
  // SSO, and passwordless flows.

  /**
   * Get public branding info for a subdomain. Only returns data when SSO is
   * actually enabled — otherwise responds 404 (same shape as an unknown
   * subdomain) so unauthenticated callers can't enumerate which orgs reserved
   * a subdomain.
   */
  @Get('subdomain/:subdomain')
  async getSubdomainBranding(@Param('subdomain') subdomain: string) {
    try {
      const branding = await this.ssoService.getPublicBranding(subdomain);
      if (!branding.ssoEnabled) {
        throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
      }
      return branding;
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.NOT_FOUND) {
        throw err;
      }
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Initiate SSO login for an organization. Any error path collapses to a 404
   * so unauthenticated callers can't tell "org doesn't exist" from "SSO not
   * configured" by inspecting the response.
   */
  @Get(':orgId/login')
  async initiateLogin(
    @Param('orgId') orgId: string,
    @Res() res: Response,
  ) {
    try {
      const org = await this.ssoService.resolveBySubdomain(orgId).catch(() => null);
      const organizationId = org ? org.id : orgId;

      const config = await this.ssoService.getSsoConfig(organizationId);
      if (!config) {
        throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
      }

      let redirectUrl: string;
      if (config.provider === 'oidc') {
        redirectUrl = await this.ssoService.initiateOidcLogin(organizationId);
      } else if (config.provider === 'saml') {
        redirectUrl = await this.ssoService.initiateSamlLogin(organizationId);
      } else {
        throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
      }

      return res.redirect(redirectUrl);
    } catch (err) {
      console.error('SSO login initiation error:', err);
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }
  }

  /**
   * OIDC callback endpoint.
   */
  @Get(':orgId/callback/oidc')
  async oidcCallback(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
      const state = req.query.state as string;

      if (!state) {
        throw new HttpException('Missing state parameter', HttpStatus.BAD_REQUEST);
      }

      const result = await this.ssoService.handleOidcCallback(orgId, callbackUrl, state);

      setSessionCookie(res, result.token);

      const frontendUrl = this.getFrontendRedirectUrl(result.organizationSlug);
      return res.redirect(`${frontendUrl}/oauth/callback`);
    } catch (err) {
      console.error('OIDC callback error:', err);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}?error=sso_failed`);
    }
  }

  /**
   * SAML ACS (Assertion Consumer Service) endpoint.
   */
  @Post(':orgId/callback/saml')
  async samlCallback(
    @Param('orgId') orgId: string,
    @Body('SAMLResponse') samlResponse: string,
    @Res() res: Response,
  ) {
    try {
      if (!samlResponse) {
        throw new HttpException('Missing SAML response', HttpStatus.BAD_REQUEST);
      }

      const result = await this.ssoService.handleSamlCallback(orgId, samlResponse);

      setSessionCookie(res, result.token);

      const frontendUrl = this.getFrontendRedirectUrl(result.organizationSlug);
      return res.redirect(`${frontendUrl}/oauth/callback`);
    } catch (err) {
      console.error('SAML callback error:', err);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}?error=sso_failed`);
    }
  }

  private getFrontendRedirectUrl(orgSlug: string): string {
    const baseDomain = process.env.BASE_DOMAIN;
    const org = orgSlug; // use slug for subdomain redirect if available
    if (baseDomain) {
      return `https://${org}.${baseDomain}`;
    }
    return process.env.FRONTEND_URL || 'http://localhost:5173';
  }
}
