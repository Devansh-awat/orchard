import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOrchardMcpServer } from './server';

@Injectable()
export class McpTransportService implements OnModuleDestroy {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  async onModuleDestroy() {
    for (const [sid, transport] of this.transports) {
      try {
        await transport.close();
      } catch {}
      this.transports.delete(sid);
    }
  }

  getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
    return this.transports.get(sessionId);
  }

  hasTransport(sessionId: string): boolean {
    return this.transports.has(sessionId);
  }

  deleteTransport(sessionId: string) {
    this.transports.delete(sessionId);
  }

  registerTransport(sessionId: string, transport: StreamableHTTPServerTransport) {
    this.transports.set(sessionId, transport);
  }

  async createSession(orchardToken: string): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createOrchardMcpServer(orchardToken);

    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) this.transports.delete(sid);
    };

    await server.connect(transport);

    return transport;
  }
}
