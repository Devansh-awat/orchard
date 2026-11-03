import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import {
  createMcpHandler,
  type AuthInfo,
  type McpRequestContext,
  type McpHttpHandler
} from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { createOrchardMcpServer, type McpMode } from './server';
import { McpOAuthService } from './mcp-oauth.service';
import type { McpScope } from './client';
import { DEFAULT_MCP_SCOPE, capScope, mcpScopeClaim } from './mcp-scopes';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { flagGatedMcpGrafts, graftsHiddenFrom } from '../grafts/mcp';

interface McpAuthExtra {
  sub: string;
  email?: string;
  externalAuthId?: string;
  sessionId: string;
  scope: McpScope;
  apiToken?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchParam(request: Request | undefined, name: string): string | null {
  if (!request) return null;
  try {
    return new URL(request.url).searchParams.get(name);
  } catch {
    return null;
  }
}

@Injectable()
export class McpTransportService implements OnModuleDestroy {
  private readonly handlers: Record<McpMode, McpHttpHandler> = {
    normal: createMcpHandler((ctx) => this.buildServer(ctx, 'normal')),
    compact: createMcpHandler((ctx) => this.buildServer(ctx, 'compact'))
  };

  private readonly nodeHandlers: Record<McpMode, NodeMcpRequestHandler> = {
    normal: toNodeHandler({
      fetch: (request, options) => this.authenticateAndDispatch('normal', request, options)
    }),
    compact: toNodeHandler({
      fetch: (request, options) => this.authenticateAndDispatch('compact', request, options)
    })
  };

  constructor(
    private readonly oauth: McpOAuthService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async handle(req: ExpressRequest, res: ExpressResponse, mode: McpMode = 'normal'): Promise<void> {
    await this.nodeHandlers[mode](req, res, req.body);
  }

  async onModuleDestroy() {
    await Promise.all(Object.values(this.handlers).map((handler) => handler.close()));
  }

  private async hiddenGrafts(sub: string | undefined): Promise<Set<string>> {
    const gated = flagGatedMcpGrafts();
    if (gated.length === 0 || !this.analytics.configured) return new Set();
    const user = sub
      ? await this.prisma.user.findFirst({
          where: UUID.test(sub) ? { id: sub } : { externalAuthId: sub },
          select: { id: true }
        })
      : null;
    return graftsHiddenFrom(gated, user?.id ?? null, (flag, userId) =>
      this.analytics.isFeatureEnabled(flag, userId)
    );
  }

  private async buildServer(ctx: McpRequestContext, mode: McpMode) {
    const extra = (ctx.authInfo?.extra ?? {}) as Partial<McpAuthExtra>;
    const scope = capScope(extra.scope ?? DEFAULT_MCP_SCOPE, searchParam(ctx.requestInfo, 'scope'));
    const toolsets = searchParam(ctx.requestInfo, 'toolsets');
    const hiddenGrafts = mode === 'compact' ? undefined : await this.hiddenGrafts(extra.sub);
    if (extra.apiToken) {
      return createOrchardMcpServer({
        token: ctx.authInfo?.token,
        scope,
        toolsets,
        mode,
        hiddenGrafts
      });
    }
    return createOrchardMcpServer({
      token: ctx.authInfo?.token,
      actingUser: {
        sub: extra.sub as string,
        email: extra.email,
        externalAuthId: extra.externalAuthId,
        sessionId: extra.sessionId as string,
        scope
      },
      scope,
      toolsets,
      mode,
      hiddenGrafts
    });
  }

  private async authenticateAndDispatch(
    mode: McpMode,
    request: Request,
    options?: { parsedBody?: unknown }
  ): Promise<Response> {
    const handler = this.handlers[mode];
    const authHeader = request.headers.get('authorization') ?? undefined;
    const apiToken = await this.oauth.validateApiToken(authHeader);
    if (apiToken) {
      return handler.fetch(request, {
        ...options,
        authInfo: {
          token: apiToken.token,
          clientId: '',
          scopes: [mcpScopeClaim(apiToken.scope)],
          extra: {
            sub: apiToken.sub,
            sessionId: '',
            scope: apiToken.scope,
            apiToken: true
          } satisfies McpAuthExtra
        }
      });
    }

    const auth = await this.oauth.validateBearerTokenWithSub(authHeader);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${this.oauth.resourceMetadataUrl}", scope="${mcpScopeClaim(DEFAULT_MCP_SCOPE)}"`
        }
      });
    }

    const authInfo: AuthInfo = {
      token: auth.token,
      clientId: '',
      scopes: [mcpScopeClaim(auth.scope)],
      extra: {
        sub: auth.sub,
        email: auth.email,
        externalAuthId: auth.externalAuthId,
        sessionId: auth.sessionId,
        scope: auth.scope
      } satisfies McpAuthExtra
    };

    return handler.fetch(request, { ...options, authInfo });
  }
}
