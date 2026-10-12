import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void | Promise<void>;

export type HostRouter = {
  matches(host: string | undefined): boolean;
  handleRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
};

type Upgrade = { graft: string; prefix: string; handler: UpgradeHandler };

@Injectable()
export class GraftHttpRegistry {
  private readonly logger = new Logger('Grafts');
  private readonly upgrades: Upgrade[] = [];
  private readonly routers: { graft: string; router: HostRouter }[] = [];

  addUpgrade(graft: string, prefix: string, handler: UpgradeHandler): void {
    this.upgrades.push({ graft, prefix: prefix.replace(/\/+$/, ''), handler });
    this.upgrades.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  addHostRouter(graft: string, router: HostRouter): void {
    this.routers.push({ graft, router });
  }

  claimsUpgradePath(url: string | undefined): boolean {
    const path = (url ?? '').split('?')[0];
    return this.upgrades.some((u) => path === u.prefix || path.startsWith(`${u.prefix}/`));
  }

  isHostRouted(host: string | undefined): boolean {
    return this.routers.some(({ router }) => safeMatch(router, host));
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    for (const { graft, router } of this.routers) {
      if (!router.handleRequest || !safeMatch(router, req.headers.host)) continue;
      try {
        if (await router.handleRequest(req, res)) return true;
      } catch (err) {
        this.logger.error(`${graft}: host router failed: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(502).end();
        return true;
      }
    }
    return false;
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    for (const { graft, router } of this.routers) {
      if (!router.handleUpgrade || !safeMatch(router, req.headers.host)) continue;
      try {
        if (await router.handleUpgrade(req, socket, head)) return true;
      } catch (err) {
        this.logger.error(`${graft}: host router upgrade failed: ${(err as Error).message}`);
        socket.destroy();
        return true;
      }
    }
    const path = (req.url ?? '').split('?')[0];
    const match = this.upgrades.find((u) => path === u.prefix || path.startsWith(`${u.prefix}/`));
    if (!match) return false;
    try {
      await match.handler(req, socket, head);
    } catch (err) {
      this.logger.error(`${match.graft}: upgrade handler failed: ${(err as Error).message}`);
      socket.destroy();
    }
    return true;
  }
}

function safeMatch(router: HostRouter, host: string | undefined): boolean {
  try {
    return router.matches(host);
  } catch {
    return false;
  }
}
