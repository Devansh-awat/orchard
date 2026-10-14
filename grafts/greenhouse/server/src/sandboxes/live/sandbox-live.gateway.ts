import * as http from 'http';
import type { Duplex } from 'stream';
import { Logger } from '@nestjs/common';
import { WebSocketServer } from 'ws';
import type { AuthDoor } from '@orchardlabs/graft-sdk/server';
import { PrismaService } from '../../prisma.service';
import { AnalyticsService } from '../../core/analytics.service';
import { InstanceSettingsService } from '../../core/instance-settings.service';
import { PUBLIC_USER_SELECT, publicUser } from '../sandbox-members.service';
import {
  FrameQueue,
  LIVE_MAX_YJS_FRAME_BYTES,
  LIVE_MAX_PENDING_FRAMES,
  isSessionId
} from './live-protocol';
import { SandboxLiveService } from './sandbox-live.service';
import { SandboxPreviewService } from '../preview/sandbox-preview.service';

export const LIVE_ROUTE_RE =
  /^\/apiv1\/(?:greenhouse\/)?sandboxes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/live$/i;

const PING_MS = 25_000;

export interface SandboxLiveGatewayDeps {
  auth: Pick<AuthDoor, 'authenticateUpgrade' | 'originAllowed' | 'rejectUpgrade'>;
  prisma: PrismaService;
  analytics: AnalyticsService;
  settings: InstanceSettingsService;
  live: SandboxLiveService;
  previews: Pick<SandboxPreviewService, 'isPreviewHost'>;
}

export function attachSandboxLiveWebSocket(server: http.Server, deps: SandboxLiveGatewayDeps) {
  const logger = new Logger('SandboxLiveGateway');
  const { auth, prisma, analytics, settings, live, previews } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_MAX_YJS_FRAME_BYTES });
  const rejectUpgrade = (socket: Duplex, code: number, message: string) =>
    auth.rejectUpgrade(socket, code, message);

  const handle = async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '', 'http://localhost');
    const match = url.pathname.match(LIVE_ROUTE_RE);
    if (!match) return;
    const sandboxId = match[1].toLowerCase();
    const sidParam = url.searchParams.get('sid');
    if (sidParam && !isSessionId(sidParam)) return rejectUpgrade(socket, 400, 'Bad Request');
    if (!(await settings.isSandboxesEnabled().catch(() => false))) {
      return rejectUpgrade(socket, 404, 'Not Found');
    }
    const identity = await auth.authenticateUpgrade(req, 'exec').catch(() => null);
    const origin = req.headers.origin;
    const originOk = Array.isArray(origin)
      ? false
      : origin === undefined || origin === ''
        ? identity !== null && identity.via !== 'cookie'
        : auth.originAllowed(origin, identity?.via === 'cookie' ? 'cookie' : 'bearer');
    if (!originOk) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (!identity) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (
      analytics.configured &&
      !(await analytics.isFeatureEnabled('greenhouse', identity.userId))
    ) {
      return rejectUpgrade(socket, 404, 'Not Found');
    }
    const role = await live
      .resolveRole(sandboxId, identity.userId, identity.orgScope)
      .catch(() => null);
    if (!role) return rejectUpgrade(socket, 404, 'Not Found');
    if (!live.hub.canAccept(sandboxId, identity.userId)) {
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    let sid: string | null = null;
    if (sidParam) {
      const owned = await prisma.sandboxConversation.count({
        where: { id: sidParam.toLowerCase(), sandboxId }
      });
      if (!owned) return rejectUpgrade(socket, 404, 'Not Found');
      sid = sidParam.toLowerCase();
    }
    const user = await prisma.user.findUnique({
      where: { id: identity.userId },
      select: PUBLIC_USER_SELECT
    });
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = live.hub.attach({
        sandboxId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        orgScope: identity.orgScope,
        user: publicUser(user),
        role,
        sid,
        socket: ws
      });
      live.hub.send(conn, { t: 'welcome', connId: conn.id, user: live.hub.publicUser(conn), role });
      let alive = true;
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {}
      }, PING_MS);
      ping.unref?.();
      const queue = new FrameQueue(LIVE_MAX_PENDING_FRAMES, (e: any) =>
        logger.warn(`live message failed: ${e?.message}`)
      );
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('message', (data, isBinary) => {
        alive = true;
        if (isBinary) {
          live.hub.send(conn, { t: 'error', code: 'binary_not_supported' });
          return;
        }
        const raw = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8');
        if (!queue.push(() => live.hub.handleMessage(conn, raw), raw.length)) {
          ws.close(1008, 'too many frames');
        }
      });
      const close = () => {
        clearInterval(ping);
        live.hub.detach(conn).catch(() => {});
      };
      ws.on('close', close);
      ws.on('error', close);
    });
  };

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url || '').split('?')[0];
    if (!LIVE_ROUTE_RE.test(path)) return;
    if (previews.isPreviewHost(req.headers.host)) return;
    handle(req, socket, head).catch((e: any) => {
      logger.warn(`live upgrade failed: ${e?.message}`);
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  });
}
