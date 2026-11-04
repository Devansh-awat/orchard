import { Controller, Get, Post, Inject, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';

// Dynamic Client Registration is anonymous by design (RFC 7591) but we cap
// the total number of clients per process so an unauthenticated attacker
// cannot spray-register clients to phish auth codes or exhaust memory.
const MAX_REGISTRATIONS_PER_WINDOW = 30;
const REGISTRATION_WINDOW_MS = 60_000;

function basicClientCredentials(
  header: string | undefined,
  body: { client_id?: string; client_secret?: string }
): { client_id?: string; client_secret?: string } {
  if (body?.client_secret || !header?.startsWith('Basic ')) return {};
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return {};
  const clientId = decodeURIComponent(decoded.slice(0, split));
  const clientSecret = decodeURIComponent(decoded.slice(split + 1));
  if (body?.client_id && body.client_id !== clientId) return {};
  return { client_id: clientId, client_secret: clientSecret };
}

@Controller()
export class McpOAuthController {
  private registrationHits: number[] = [];

  constructor(@Inject(McpOAuthService) private readonly oauthService: McpOAuthService) {}

  @Get('.well-known/oauth-protected-resource')
  getProtectedResourceMetadata() {
    return this.oauthService.getProtectedResourceMetadata();
  }

  @Get('.well-known/oauth-authorization-server')
  getAuthorizationServerMetadata() {
    return this.oauthService.getAuthorizationServerMetadata();
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async registerClient(@Req() req: Request, @Res() res: Response) {
    const now = Date.now();
    this.registrationHits = this.registrationHits.filter((t) => now - t < REGISTRATION_WINDOW_MS);
    if (this.registrationHits.length >= MAX_REGISTRATIONS_PER_WINDOW) {
      return res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: 'rate_limited',
        error_description: 'too many client registrations'
      });
    }
    this.registrationHits.push(now);

    const result = await this.oauthService.registerClient(req.body);
    if (result.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: result.error,
        ...(result.error_description && { error_description: result.error_description })
      });
    }
    return res.status(HttpStatus.CREATED).json(result.registration);
  }

  @Get('authorize')
  async authorize(@Req() req: Request, @Res() res: Response) {
    const query = req.query as Record<string, string>;
    const result = await this.oauthService.buildAuthorizeRedirect({
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      response_type: query.response_type,
      state: query.state,
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
      scope: query.scope
    });

    if (result.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: result.error,
        ...(result.error_description ? { error_description: result.error_description } : {})
      });
    }

    return res.redirect(result.redirectUrl!);
  }

  @Post('authorize/complete')
  async completeAuthorization(@Req() req: Request, @Res() res: Response) {
    try {
      const result = await this.oauthService.completeAuthorization({
        mcp_state: req.body.mcp_state,
        session_token: req.body.session_token,
        scope: req.body.scope,
        redirect_uri: req.body.redirect_uri,
        client_name: req.body.client_name
      });

      if (result.error) {
        return res.status(HttpStatus.BAD_REQUEST).json({ error: result.error });
      }

      return res.json({ redirect_url: result.redirectUrl });
    } catch (err) {
      console.error('MCP authorize/complete error:', err);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Authorization failed' });
    }
  }

  @Post('token')
  async exchangeToken(@Req() req: Request, @Res() res: Response) {
    console.error(
      `[MCP OAuth] Token exchange: grant_type=${req.body.grant_type}, client_id=${req.body.client_id}, code_length=${req.body.code?.length || 0}`
    );
    const result = await this.oauthService.exchangeToken({
      ...req.body,
      ...basicClientCredentials(req.headers.authorization, req.body)
    });

    if (result.error) {
      console.error(
        `[MCP OAuth] Token exchange failed: ${result.error} ${result.error_description || ''}`
      );
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: result.error,
        ...(result.error_description && {
          error_description: result.error_description
        })
      });
    }

    console.error(
      `[MCP OAuth] Token exchange succeeded, access_token length: ${result.token_response?.access_token?.length || 0}`
    );
    return res.json(result.token_response);
  }
}
