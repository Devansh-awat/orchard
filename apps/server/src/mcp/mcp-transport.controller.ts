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
      // M-6: bind every dispatch to the bearer's `sub`. The MCP transport
      // session holds an `OrchardClient` minted with the creator's orchard
      // token; without a sub-match check, any other MCP user who learns the
      // session id can dispatch tool calls that hit the first-party API as
      // the original creator.
      const auth = await this.oauthService.validateBearerTokenWithSub(
        req.headers.authorization,
      );
      if (!auth) {
        console.error('[MCP] POST / - auth failed');
        this.send401(res);
        return;
      }

      if (sessionId) {
        const transport = this.transportService.getTransportForCaller(
          sessionId,
          auth.sub,
        );
        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }
        // Either the session doesn't exist or the caller isn't its owner.
        // Return the same 404 in both cases — distinguishing them turns a
        // leaked session id into an existence oracle and reveals that the
        // caller would need a different identity to use it.
        console.error(`[MCP] POST / - session not found or not owned: ${sessionId}`);
        res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
        return;
      }

      const { transport } = await this.transportService.createSession(
        auth.token,
        auth.sub,
        {
          sub: auth.sub,
          email: auth.email,
          externalAuthId: auth.externalAuthId,
          sessionId: auth.sessionId,
        },
      );
      await transport.handleRequest(req, res, req.body);
      // sessionId is only available after handleRequest processes the initialize message
      const newSessionId = (transport as any).sessionId as string;
      if (newSessionId) {
        this.transportService.registerTransport(newSessionId, transport, auth.sub);
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
    const auth = await this.oauthService.validateBearerTokenWithSub(
      req.headers.authorization,
    );
    if (!auth) {
      this.send401(res);
      return;
    }

    if (!sessionId) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    const transport = this.transportService.getTransportForCaller(sessionId, auth.sub);
    if (!transport) {
      console.error(`[MCP] GET / - session not found or not owned: ${sessionId}`);
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const auth = await this.oauthService.validateBearerTokenWithSub(
      req.headers.authorization,
    );
    if (!auth) {
      this.send401(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    const transport = this.transportService.getTransportForCaller(sessionId, auth.sub);
    if (!transport) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
    this.transportService.deleteTransport(sessionId);
  }
}
