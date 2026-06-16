import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOrchardMcpServer } from './server';
import type { ActingUser } from './client';

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  // Owner of this MCP session, taken from the JWT `sub` claim at creation.
  // Subsequent requests reusing the same session id MUST present a bearer
  // whose sub matches — otherwise a leaked `mcp-session-id` lets any other
  // authenticated MCP user dispatch tool calls against this transport's
  // `OrchardClient`, running as the original creator against the
  // first-party API.
  ownerSub: string;
}

@Injectable()
export class McpTransportService implements OnModuleDestroy {
  private readonly transports = new Map<string, TransportEntry>();

  async onModuleDestroy() {
    for (const [sid, entry] of this.transports) {
      try {
        await entry.transport.close();
      } catch {}
      this.transports.delete(sid);
    }
  }

  /**
   * Resolve a session for a caller. Returns `undefined` if the session
   * does not exist OR if the caller's `sub` does not match the session's
   * owner. Treating "doesn't exist" and "exists but not yours" identically
   * keeps a leaked session id from being usable as an existence oracle.
   */
  getTransportForCaller(
    sessionId: string,
    callerSub: string,
  ): StreamableHTTPServerTransport | undefined {
    const entry = this.transports.get(sessionId);
    if (!entry) return undefined;
    if (entry.ownerSub !== callerSub) return undefined;
    return entry.transport;
  }

  hasTransport(sessionId: string): boolean {
    return this.transports.has(sessionId);
  }

  deleteTransport(sessionId: string) {
    this.transports.delete(sessionId);
  }

  registerTransport(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
    ownerSub: string,
  ) {
    this.transports.set(sessionId, { transport, ownerSub });
  }

  async createSession(
    orchardToken: string,
    ownerSub: string,
    actingUser: ActingUser,
  ): Promise<{ transport: StreamableHTTPServerTransport; ownerSub: string }> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createOrchardMcpServer(orchardToken, actingUser);

    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) this.transports.delete(sid);
    };

    await server.connect(transport);

    return { transport, ownerSub };
  }
}
