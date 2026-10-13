import * as http from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { AuthDoor } from '@orchard/graft-sdk/server';
import { PrismaService } from '../prisma.service';
import { SessionsService } from '../core/sessions.service';
import { AuditService } from '../core/audit.service';
import { AnalyticsService } from '../core/analytics.service';
import { InstanceSettingsService } from '../core/instance-settings.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxRef, SandboxRunner, refOf } from './runners/sandbox-runner';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxGateScope, sandboxSshAccess } from './sandbox-role-gate';

const ROUTE_RE = /^\/apiv1\/(?:greenhouse\/)?sandboxes\/([0-9a-f-]{36})\/ssh$/;
const RECHECK_INTERVAL_MS = 15_000;
const ACTIVITY_INTERVAL_MS = 60_000;
const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1024 * 1024;
const WS_MAX_PAYLOAD = 64 * 1024;
const MAX_CONNECTIONS_PER_USER = 8;
const MAX_CONNECTIONS_GLOBAL = 200;

const connectionsByUser = new Map<string, number>();
let connectionsTotal = 0;

function overConnectionLimit(userId: string): boolean {
  if (connectionsTotal >= MAX_CONNECTIONS_GLOBAL) return true;
  return (connectionsByUser.get(userId) ?? 0) >= MAX_CONNECTIONS_PER_USER;
}

function trackConnection(userId: string): () => void {
  connectionsTotal += 1;
  connectionsByUser.set(userId, (connectionsByUser.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    connectionsTotal -= 1;
    const n = (connectionsByUser.get(userId) ?? 1) - 1;
    if (n <= 0) connectionsByUser.delete(userId);
    else connectionsByUser.set(userId, n);
  };
}

export function sshUpgradeSandboxId(
  req: http.IncomingMessage,
  skipUpgrade?: (req: http.IncomingMessage) => boolean
): string | null {
  const url = new URL(req.url || '', 'http://localhost');
  const match = url.pathname.match(ROUTE_RE);
  if (!match) return null;
  if (skipUpgrade?.(req)) return null;
  return match[1].toLowerCase();
}

export interface SandboxSshGatewayDeps {
  auth: Pick<AuthDoor, 'authenticateTerminalUpgrade'>;
  prisma: PrismaService;
  sessions: SessionsService;
  audit: AuditService;
  registry: SandboxRunnerRegistry;
  settings: InstanceSettingsService;
  analytics: AnalyticsService;
  accessService: SandboxAccessService;
}

export function attachSandboxSshWebSocket(
  server: http.Server,
  deps: SandboxSshGatewayDeps,
  skipUpgrade?: (req: http.IncomingMessage) => boolean
) {
  const {
    auth: authDoor,
    prisma,
    sessions,
    audit,
    registry,
    settings,
    analytics,
    accessService
  } = deps;

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
    const sandboxId = sshUpgradeSandboxId(req, skipUpgrade);
    if (!sandboxId) return;

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    if (!(await settings.isSandboxesEnabled().catch(() => false))) {
      return reject(404, 'Not Found');
    }

    const auth = await authDoor.authenticateTerminalUpgrade(req);
    if ('reject' in auth) return reject(auth.reject, auth.message);
    const userId = auth.userId;
    const actorEmail = auth.actorEmail;
    const sessionIdForRecheck = auth.browserSessionId;
    if (analytics.configured && !(await analytics.isFeatureEnabled('greenhouse', userId))) {
      return reject(404, 'Not Found');
    }

    const scope: SandboxGateScope = {
      sessionOrgId: auth.sessionOrgScope ?? null,
      tokenProjectIds: auth.tokenAuthCtx?.tokenProjectIds ?? null
    };
    const authorize = async (): Promise<{ ok: boolean; ref?: SandboxRef }> => {
      const access = await sandboxSshAccess(accessService, sandboxId, userId, scope);
      if (!access || access.sandbox.status !== 'running') return { ok: false };
      return { ok: true, ref: refOf(access.sandbox) };
    };

    const authzResult = await authorize();
    if (!authzResult.ok || !authzResult.ref) return reject(404, 'Not Found');
    if (overConnectionLimit(userId)) return reject(429, 'Too Many Requests');
    const ref = authzResult.ref;
    let runner: SandboxRunner;
    try {
      runner = registry.for(ref);
    } catch {
      return reject(404, 'Not Found');
    }

    let tunnel: Duplex;
    try {
      tunnel = await runner.openTcp(ref, 22);
    } catch {
      return reject(502, 'Bad Gateway');
    }

    audit
      .log({
        action: 'sandbox.ssh.connect',
        actorUserId: userId,
        actorEmail: actorEmail ?? null,
        targetType: 'sandbox',
        targetId: sandboxId,
        metadata: { podName: ref.podName, runner: ref.runner }
      })
      .catch(() => {});

    const recheckAuth = async (): Promise<boolean> => {
      try {
        if (sessionIdForRecheck) {
          const valid = await sessions.validateSession(sessionIdForRecheck);
          if (!valid) return false;
        }
        return (await authorize()).ok;
      } catch {
        return false;
      }
    };

    const release = trackConnection(userId);
    let upgraded = false;
    socket.once('close', () => {
      if (upgraded) return;
      release();
      tunnel.destroy();
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      wss.emit('connection', ws, req);
      ws.on('close', release);
      ws.on('error', release);
      handleTunnel(ws, tunnel, sandboxId, prisma, recheckAuth);
    });
  });
}

function attachLifecycle(
  ws: WebSocket,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>,
  teardown: () => void
) {
  const touch = () => {
    prisma.sandbox
      .update({ where: { id: sandboxId }, data: { lastActiveAt: new Date() } })
      .catch(() => {});
  };
  touch();
  const activityTimer = setInterval(touch, ACTIVITY_INTERVAL_MS);
  const recheckTimer = setInterval(() => {
    void recheckAuth().then((ok) => {
      if (ok) return;
      if (ws.readyState === WebSocket.OPEN) ws.close(4401, 'access revoked');
      teardown();
    });
  }, RECHECK_INTERVAL_MS);
  const stop = () => {
    clearInterval(activityTimer);
    clearInterval(recheckTimer);
    touch();
  };
  ws.on('close', stop);
  ws.on('error', stop);
}

function handleTunnel(
  ws: WebSocket,
  tunnel: Duplex,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>
) {
  attachLifecycle(ws, sandboxId, prisma, recheckAuth, () => tunnel.destroy());

  tunnel.on('data', (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > WS_HIGH_WATER) {
      tunnel.pause();
      const drainCheck = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(drainCheck);
          return;
        }
        if (ws.bufferedAmount < WS_LOW_WATER) {
          clearInterval(drainCheck);
          tunnel.resume();
        }
      }, 50);
    }
  });

  ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    const ok = tunnel.write(buf);
    if (!ok) {
      ws.pause();
      tunnel.once('drain', () => ws.resume());
    }
  });

  tunnel.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'connection closed');
  });
  tunnel.on('error', (err) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message.slice(0, 120));
  });
  ws.on('close', () => tunnel.destroy());
  ws.on('error', () => tunnel.destroy());
}
