import {
  Controller,
  Get,
  Post,
  Inject,
  Req,
  Res,
  HttpCode,
  HttpException,
  HttpStatus
} from '@nestjs/common';
import { Request, Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { getClientIp } from '../auth/client-ip';

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
  constructor(
    @Inject(McpOAuthService) private readonly oauthService: McpOAuthService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService
  ) {}

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
    try {
      await this.rateLimit.checkRateLimit(getClientIp(req), 'ip', 'mcp_register');
      await this.rateLimit.checkRateLimit('all', 'global', 'mcp_register');
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          error: 'rate_limited',
          error_description: 'too many client registrations'
        });
      }
      throw e;
    }

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
