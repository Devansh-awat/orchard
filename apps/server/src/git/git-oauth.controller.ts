import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Public } from '../auth/decorators';
import { setGitOauthStateCookie, clearGitOauthStateCookie } from '../auth/cookies';
import { GitHubService } from '../github/github.service';
import { UsersService } from '../users/users.service';
import { GitConnectionsService } from './git-connections.service';
import { GitOauthService, OAUTH_PROVIDERS, type OauthProvider } from './git-oauth.service';

function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function back(res: Response, query: string): void {
  res.redirect(`${frontendUrl()}/user/settings?tab=connections&${query}`);
}

function nonceMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Same ceremony as the GitHub link: the session token rides in the OAuth
 * state so the callback can find the user even when the browser drops the
 * cookie on the cross-site hop, and a nonce cookie ties the two legs.
 */
@Controller('git/oauth')
export class GitOauthController {
  constructor(
    private readonly oauth: GitOauthService,
    private readonly connections: GitConnectionsService,
    private readonly github: GitHubService,
    private readonly users: UsersService
  ) {}

  private providerOrNull(raw: string): OauthProvider | null {
    return OAUTH_PROVIDERS.includes(raw as OauthProvider) ? (raw as OauthProvider) : null;
  }

  @Public()
  @Get(':provider/start')
  async start(@Param('provider') raw: string, @Req() req: any, @Res() res: Response) {
    const provider = this.providerOrNull(raw);
    if (!provider) return back(res, `error=${encodeURIComponent('Unknown provider')}`);
    const token = req.cookies?.session_token;
    if (!token) return back(res, `error=${encodeURIComponent('Not authenticated')}`);
    try {
      await this.github.verifySessionToken(token);
    } catch {
      return back(res, `error=${encodeURIComponent('Not authenticated')}`);
    }
    let url: string;
    const nonce = randomBytes(32).toString('hex');
    const state = Buffer.from(JSON.stringify({ t: token, n: nonce })).toString('base64url');
    try {
      url = this.oauth.authorizeUrl(provider, state);
    } catch (e) {
      return back(res, `error=${encodeURIComponent((e as Error).message)}`);
    }
    setGitOauthStateCookie(res, nonce);
    return res.redirect(url);
  }

  @Public()
  @Get(':provider/callback')
  async callback(
    @Param('provider') raw: string,
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Query('state') state: string,
    @Req() req: any,
    @Res() res: Response
  ) {
    const provider = this.providerOrNull(raw);
    if (!provider) return back(res, `error=${encodeURIComponent('Unknown provider')}`);
    if (error) return back(res, `error=${encodeURIComponent(errorDescription || error)}`);
    if (!code) return back(res, `error=${encodeURIComponent('No authorization code provided')}`);
    let parsed: { t?: string; n?: string } = {};
    try {
      parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
    } catch {
      parsed = {};
    }
    const cookieNonce = req.cookies?.git_oauth_state;
    clearGitOauthStateCookie(res);
    if (!nonceMatches(parsed.n, cookieNonce)) {
      return back(
        res,
        `error=${encodeURIComponent("Couldn't verify this link request. Try connecting again.")}`
      );
    }
    const token = req.cookies?.session_token || parsed.t;
    if (!token) return back(res, `error=${encodeURIComponent('Not authenticated')}`);
    try {
      const payload = await this.github.verifySessionToken(token);
      const user = payload.externalAuthId
        ? await this.users.findByExternalAuthId(payload.externalAuthId)
        : await this.users.findById(payload.sub);
      if (!user) return back(res, `error=${encodeURIComponent('Not authenticated')}`);
      const tokens = await this.oauth.exchange(provider, code);
      const identity = await this.oauth.identity(provider, tokens.accessToken);
      const connection = await this.connections.upsertOauth(user.id, provider, tokens, identity);
      return back(res, `git=linked&provider=${encodeURIComponent(connection.name)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return back(res, `error=${encodeURIComponent(msg)}`);
    }
  }
}
