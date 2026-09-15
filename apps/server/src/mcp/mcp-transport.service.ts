import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import {
  createMcpHandler,
  type AuthInfo,
  type McpRequestContext,
  type McpHttpHandler
} from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { createOrchardMcpServer } from './server';
import { McpOAuthService } from './mcp-oauth.service';

// Identity we thread from the validated bearer to the per-request server via
// AuthInfo.extra (pass-through — the handler never reads headers itself).
interface McpAuthExtra {
  sub: string;
  email?: string;
  externalAuthId?: string;
  sessionId: string;
}

@Injectable()
export class McpTransportService implements OnModuleDestroy {
  // 2026-07-28 stateless serving. createMcpHandler builds a fresh McpServer per
  // request via the factory and holds nothing between requests: no session map,
  // no Mcp-Session-Id, so restarts and multiple replicas can't strand a
  // client. A 2025-era client (today's Claude) is still served through the
  // handler's built-in legacy fallback, so this is drop-in for existing
  // connections.
  private readonly handler: McpHttpHandler = createMcpHandler((ctx) => this.buildServer(ctx));

  // The handler does no auth of its own; we gate every request with our own
  // bearer validation (which enforces session revocation) and pass the result
  // through as AuthInfo. toNodeHandler bridges Express <-> web Request/Response,
  // including SSE streaming.
  private readonly nodeHandler: NodeMcpRequestHandler = toNodeHandler({
    fetch: (request, options) => this.authenticateAndDispatch(request, options)
  });

  constructor(private readonly oauth: McpOAuthService) {}

  async handle(req: ExpressRequest, res: ExpressResponse): Promise<void> {
    await this.nodeHandler(req, res, req.body);
  }

  async onModuleDestroy() {
    await this.handler.close();
  }

  private buildServer(ctx: McpRequestContext) {
    // authInfo is always present: authenticateAndDispatch refuses the request
    // before calling handler.fetch when the bearer is missing or invalid.
    const extra = (ctx.authInfo?.extra ?? {}) as Partial<McpAuthExtra>;
    return createOrchardMcpServer(ctx.authInfo?.token, {
      sub: extra.sub as string,
      email: extra.email,
      externalAuthId: extra.externalAuthId,
      sessionId: extra.sessionId as string
    });
  }

  private async authenticateAndDispatch(
    request: Request,
    options?: { parsedBody?: unknown }
  ): Promise<Response> {
    // M-6: bind every dispatch to the bearer's `sub`. The per-request server
    // built for this call holds an OrchardClient minted with this caller's
    // identity, so validating here (and caching nothing) is what keeps one
    // user's tool calls from ever running as another.
    const auth = await this.oauth.validateBearerTokenWithSub(
      request.headers.get('authorization') ?? undefined
    );
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${this.oauth.resourceMetadataUrl}", scope="mcp:access"`
        }
      });
    }

    const authInfo: AuthInfo = {
      token: auth.token,
      clientId: '',
      scopes: ['mcp:access'],
      extra: {
        sub: auth.sub,
        email: auth.email,
        externalAuthId: auth.externalAuthId,
        sessionId: auth.sessionId
      } satisfies McpAuthExtra
    };

    return this.handler.fetch(request, { ...options, authInfo });
  }
}
