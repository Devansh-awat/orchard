import { Controller, Get, Post, Inject, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';

@Controller()
export class McpOAuthController {
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
  registerClient(@Req() req: Request) {
    return this.oauthService.registerClient(req.body);
  }

  @Get('authorize')
  authorize(@Req() req: Request, @Res() res: Response) {
    const query = req.query as Record<string, string>;
    const result = this.oauthService.buildAuthorizeRedirect({
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      response_type: query.response_type,
      state: query.state,
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
    });

    if (result.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: result.error });
    }

    return res.redirect(result.redirectUrl!);
  }

  @Get('oauth/callback')
  async oauthCallback(@Req() req: Request, @Res() res: Response) {
    const query = req.query as Record<string, string>;

    try {
      const result = await this.oauthService.handleOAuthCallback({
        code: query.code,
        state: query.state,
        error: query.error,
      });

      if (result.error) {
        return res.status(HttpStatus.BAD_REQUEST).send(result.error);
      }

      return res.redirect(result.redirectUrl!);
    } catch (err) {
      console.error('OAuth callback error:', err);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Authentication failed');
    }
  }

  @Post('token')
  exchangeToken(@Req() req: Request, @Res() res: Response) {
    console.error(`[MCP OAuth] Token exchange: grant_type=${req.body.grant_type}, client_id=${req.body.client_id}, code_length=${req.body.code?.length || 0}`);
    const result = this.oauthService.exchangeToken(req.body);

    if (result.error) {
      console.error(`[MCP OAuth] Token exchange failed: ${result.error} ${result.error_description || ''}`);
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: result.error,
        ...(result.error_description && {
          error_description: result.error_description,
        }),
      });
    }

    console.error(`[MCP OAuth] Token exchange succeeded, access_token length: ${result.token_response?.access_token?.length || 0}`);
    return res.json(result.token_response);
  }
}
