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

@Public()
@Controller('sso')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  private isSessionCookieSecure(): boolean {
    const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
    if (override === 'true') return true;
    if (override === 'false') return false;
    return process.env.NODE_ENV === 'production';
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: this.isSessionCookieSecure(),
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      domain: process.env.COOKIE_DOMAIN || undefined,
    });
  }

  /**
   * Get public branding info for a subdomain.
   * Used by the frontend to render the branded SSO login page.
   */
  @Get('subdomain/:subdomain')
  async getSubdomainBranding(@Param('subdomain') subdomain: string) {
    return this.ssoService.getPublicBranding(subdomain);
  }

  /**
   * Initiate SSO login for an organization.
   * Redirects to the IdP (OIDC authorize URL or SAML entry point).
   */
  @Get(':orgId/login')
  async initiateLogin(
    @Param('orgId') orgId: string,
    @Res() res: Response,
  ) {
    try {
      const org = await this.ssoService.resolveBySubdomain(orgId).catch(() => null);
      const organizationId = org ? org.id : orgId;

      const config = await this.getSsoConfigForOrg(organizationId);

      let redirectUrl: string;
      if (config.provider === 'oidc') {
        redirectUrl = await this.ssoService.initiateOidcLogin(organizationId);
      } else if (config.provider === 'saml') {
        redirectUrl = await this.ssoService.initiateSamlLogin(organizationId);
      } else {
        throw new HttpException('Unknown SSO provider', HttpStatus.BAD_REQUEST);
      }

      return res.redirect(redirectUrl);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      console.error('SSO login initiation error:', err);
      throw new HttpException('Failed to initiate SSO login', HttpStatus.INTERNAL_SERVER_ERROR);
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

      this.setSessionCookie(res, result.token);

      const frontendUrl = this.getFrontendRedirectUrl(result.organizationSlug);
      return res.redirect(`${frontendUrl}/oauth/callback`);
    } catch (err) {
      console.error('OIDC callback error:', err);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const errorMsg = err instanceof HttpException ? err.message : 'SSO authentication failed';
      return res.redirect(`${frontendUrl}?error=${encodeURIComponent(errorMsg)}`);
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

      this.setSessionCookie(res, result.token);

      const frontendUrl = this.getFrontendRedirectUrl(result.organizationSlug);
      return res.redirect(`${frontendUrl}/oauth/callback`);
    } catch (err) {
      console.error('SAML callback error:', err);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const errorMsg = err instanceof HttpException ? err.message : 'SSO authentication failed';
      return res.redirect(`${frontendUrl}?error=${encodeURIComponent(errorMsg)}`);
    }
  }

  private async getSsoConfigForOrg(organizationId: string) {
    const config = await this.ssoService.getSsoConfig(organizationId);
    if (!config) {
      throw new HttpException('SSO is not configured for this organization', HttpStatus.BAD_REQUEST);
    }
    return config;
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
