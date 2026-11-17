import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  Body,
  Header,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SsoProtocol } from '@prisma/client';
import { SsoService } from './sso.service';
import { SsoLoginService, SsoLoginResult } from './sso-login.service';
import { Public } from '../auth/decorators';
import {
  clearSsoStartCookie,
  readSessionCookie,
  setSessionCookie,
  setSsoStartCookie,
  ssoStartCookie
} from '../auth/cookies';

@Public()
@Controller('sso')
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(
    private readonly sso: SsoService,
    private readonly login: SsoLoginService
  ) {}

  private get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  /** Identity providers offered to everyone on the platform login page. */
  @Get('providers')
  getInstanceProviders() {
    return this.sso.getInstanceProviders();
  }

  /**
   * Login-page payload for one organization, keyed on its slug: the same slug
   * that addresses it everywhere else in the product. 404 covers both "no such
   * org" and "SSO not live here" so this can't enumerate tenants.
   */
  @Get('org/:slug')
  async getOrgLogin(@Param('slug') slug: string) {
    const context = await this.sso.getOrgLoginContext(slug);
    if (!context) throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    return context;
  }

  /**
   * Resolve a legacy vanity subdomain to the org whose login page replaced it.
   * The frontend calls this once when someone lands on acme.orchard.my.
   */
  @Get('subdomain/:subdomain')
  async resolveSubdomain(@Param('subdomain') subdomain: string) {
    const context = await this.sso.getOrgLoginContextBySubdomain(subdomain);
    if (!context) throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    return { slug: context.slug, name: context.name };
  }

  /** Work-email routing for the platform login page. Always 200. */
  @Post('discover')
  async discover(@Body('email') email: string) {
    const match = email ? await this.sso.discoverByEmail(email) : null;
    return { organization: match };
  }

  @Get('start/:providerId')
  async start(
    @Param('providerId') providerId: string,
    @Query('returnTo') returnTo: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      const { url, startToken } = await this.login.startLogin(
        providerId,
        returnTo,
        readSessionCookie(req.cookies)
      );
      setSsoStartCookie(res, startToken);
      return res.redirect(url);
    } catch (err) {
      this.logger.warn(`SSO start failed for ${providerId}: ${(err as Error).message}`);
      return res.redirect(`${this.frontendUrl}?error=sso_failed`);
    }
  }

  @Get('callback/:providerId')
  async callback(
    @Param('providerId') providerId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      const provider = await this.login.loadLoginProvider(providerId);
      const state = req.query.state as string;
      if (!state) throw new HttpException('Missing state parameter', HttpStatus.BAD_REQUEST);
      const start = await this.login.readStartToken(providerId, ssoStartCookie(req), state);

      const result =
        provider.protocol === SsoProtocol.oauth2
          ? await this.login.handleOAuth2Callback(
              providerId,
              req.query.code as string,
              state,
              start.linkedUserId,
              start.linkedSessionId
            )
          : await this.login.handleOidcCallback(
              providerId,
              this.requestUrl(req),
              state,
              start.linkedUserId,
              start.linkedSessionId
            );

      return this.finish(res, result);
    } catch (err) {
      return this.fail(res, err);
    }
  }

  /** SAML assertion consumer service. */
  @Post('callback/:providerId')
  async samlCallback(
    @Param('providerId') providerId: string,
    @Body('SAMLResponse') samlResponse: string,
    @Body('RelayState') relayState: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      if (!samlResponse) throw new HttpException('Missing SAML response', HttpStatus.BAD_REQUEST);
      const result = await this.login.handleSamlCallback(
        providerId,
        samlResponse,
        relayState,
        ssoStartCookie(req)
      );
      return this.finish(res, result);
    } catch (err) {
      return this.fail(res, err);
    }
  }

  /** SP metadata, for pasting into the IdP. */
  @Get('providers/:providerId/metadata')
  @Header('Content-Type', 'application/xml')
  async metadata(@Param('providerId') providerId: string) {
    return this.sso.getSpMetadata(providerId);
  }

  // Legacy routes. The org-scoped callback URLs predate identity providers and are
  // registered on IdPs we don't control, so they keep working forever. New
  // connections use /sso/callback/:providerId.

  @Get(':orgId/login')
  async legacyLogin(@Param('orgId') orgId: string, @Res() res: Response) {
    try {
      const org = await this.sso.getOrgLoginContextById(orgId);
      if (!org) throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
      return res.redirect(this.sso.orgLoginUrl(org.slug));
    } catch {
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }
  }

  @Get(':orgId/callback/oidc')
  async legacyOidcCallback(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      const state = req.query.state as string;
      if (!state) throw new HttpException('Missing state parameter', HttpStatus.BAD_REQUEST);
      const provider = await this.login.findLegacyProvider(orgId, SsoProtocol.oidc);
      const start = await this.login.readStartToken(provider.id, ssoStartCookie(req), state);
      const result = await this.login.handleOidcCallback(
        provider.id,
        this.requestUrl(req),
        state,
        start.linkedUserId,
        start.linkedSessionId
      );
      return this.finish(res, result);
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Post(':orgId/callback/saml')
  async legacySamlCallback(
    @Param('orgId') orgId: string,
    @Body('SAMLResponse') samlResponse: string,
    @Body('RelayState') relayState: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      if (!samlResponse) throw new HttpException('Missing SAML response', HttpStatus.BAD_REQUEST);
      const provider = await this.login.findLegacyProvider(orgId, SsoProtocol.saml);
      const result = await this.login.handleSamlCallback(
        provider.id,
        samlResponse,
        relayState,
        ssoStartCookie(req)
      );
      return this.finish(res, result);
    } catch (err) {
      return this.fail(res, err);
    }
  }

  private requestUrl(req: Request): URL {
    return new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  }

  private finish(res: Response, result: SsoLoginResult) {
    clearSsoStartCookie(res);
    if (result.token) setSessionCookie(res, result.token);
    return res.redirect(result.redirectTo);
  }

  private fail(res: Response, err: unknown) {
    this.logger.warn(`SSO callback failed: ${err instanceof Error ? err.message : String(err)}`);
    const reason =
      err instanceof Error &&
      /private_beta|signups_disabled|sso_link_required|sso_not_mapped|sso_sign_in_first|sso_access_disabled|sso_member_limit/.test(
        err.message
      )
        ? err.message
        : 'sso_failed';
    const orgSlug = err instanceof HttpException && (err.getResponse() as any)?.orgSlug;
    if (orgSlug) {
      return res.redirect(
        `${this.frontendUrl}/${encodeURIComponent(orgSlug)}/login?error=${encodeURIComponent(reason)}`
      );
    }
    return res.redirect(`${this.frontendUrl}?error=${encodeURIComponent(reason)}`);
  }
}
