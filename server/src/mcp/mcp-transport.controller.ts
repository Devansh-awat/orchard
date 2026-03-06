import { Controller, Post, Get, Delete, Inject, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';
import { McpTransportService } from './mcp-transport.service';

@Controller()
export class McpTransportController {
  constructor(
    @Inject(McpOAuthService) private readonly oauthService: McpOAuthService,
    @Inject(McpTransportService) private readonly transportService: McpTransportService,
  ) {}

  private send401(res: Response) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${this.oauthService.resourceMetadataUrl}", scope="mcp:access"`,
    );
    res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[MCP] POST / - session: ${sessionId || 'none'}, method: ${req.body?.method || 'N/A'}`);
    try {
      const orchardToken = await this.oauthService.validateBearerToken(
        req.headers.authorization,
      );
      if (!orchardToken) {
        console.error('[MCP] POST / - auth failed');
        this.send401(res);
        return;
      }

      if (sessionId && this.transportService.hasTransport(sessionId)) {
        const transport = this.transportService.getTransport(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && !this.transportService.hasTransport(sessionId)) {
        console.error(`[MCP] POST / - session not found: ${sessionId}`);
        res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
        return;
      }

      const transport = await this.transportService.createSession(orchardToken);
      await transport.handleRequest(req, res, req.body);
      // sessionId is only available after handleRequest processes the initialize message
      const newSessionId = (transport as any).sessionId as string;
      if (newSessionId) {
        this.transportService.registerTransport(newSessionId, transport);
        console.error(`[MCP] POST / - new session registered: ${newSessionId}`);
      }
    } catch (err) {
      console.error('MCP POST error:', err instanceof Error ? err.stack : err);
      if (!res.headersSent) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          error: 'Internal server error',
        });
      }
    }
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[MCP] GET / - session: ${sessionId || 'none'}`);
    const orchardToken = await this.oauthService.validateBearerToken(
      req.headers.authorization,
    );
    if (!orchardToken) {
      this.send401(res);
      return;
    }

    if (!sessionId || !this.transportService.hasTransport(sessionId)) {
      console.error(`[MCP] GET / - session not found: ${sessionId}`);
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    await this.transportService.getTransport(sessionId)!.handleRequest(req, res);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const orchardToken = await this.oauthService.validateBearerToken(
      req.headers.authorization,
    );
    if (!orchardToken) {
      this.send401(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.transportService.hasTransport(sessionId)) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    await this.transportService.getTransport(sessionId)!.handleRequest(req, res);
    this.transportService.deleteTransport(sessionId);
  }
}
