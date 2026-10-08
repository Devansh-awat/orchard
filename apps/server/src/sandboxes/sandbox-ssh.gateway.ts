import * as http from 'http';
import type { Duplex } from 'stream';
import WebSocket from 'ws';
import { jwtVerify } from 'jose';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { hashApiToken } from '../auth/api-tokens.service';
import { assertBrowserSession } from '../auth/session-jwt';
import { AnalyticsService } from '../analytics/analytics.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, SandboxRef, SandboxRunner, refOf } from './runners/sandbox-runner';

const ROUTE_RE = /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/ssh$/;
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

export function attachSandboxSshWebSocket(server: http.Server, app: INestApplication) {
  const prisma = app.get(PrismaService);
  const sessions = app.get(SessionsService);
  const audit = app.get(AuditService);
  const registry = app.get(SandboxRunnerRegistry);
  const settings = app.get(InstanceSettingsService);
  const analytics = app.get(AnalyticsService);

  const wss = new WebSocket.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET || '');

  server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(ROUTE_RE);
    if (!match) return;

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    if (!(await settings.isSandboxesEnabled().catch(() => false))) {
      return reject(404, 'Not Found');
    }

    const cookies = parseCookies(req.headers.cookie || '');
    const authHeader = req.headers['authorization'];
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
    const token = cookies['session_token'] || bearer;
    if (!token) return reject(401, 'Unauthorized');

    let userId: string | undefined;
    let actorEmail: string | undefined;
    let sessionIdForRecheck: string | undefined;
    try {
      const { payload } = await jwtVerify(token, jwtSecret);
      const sessionId = assertBrowserSession(payload);
      const sessionValid = await sessions.validateSession(sessionId);
      if (!sessionValid) return reject(401, 'Unauthorized');
      sessionIdForRecheck = sessionId;
      const externalAuthId = (payload.externalAuthId ?? payload.hackClubId ?? payload.sub) as
        | string
        | undefined;
      const dbUser = await prisma.user.findFirst({
        where: {
          OR: [
            ...(typeof payload.sub === 'string' && payload.sub.includes('-')
              ? [{ id: payload.sub as string }]
              : []),
            ...(externalAuthId ? [{ externalAuthId }] : [])
          ]
        },
        select: { id: true, email: true }
      });
      if (!dbUser) return reject(401, 'Unauthorized');
      userId = dbUser.id;
      actorEmail = dbUser.email;
    } catch {
      if (!token.startsWith('orch_')) return reject(401, 'Unauthorized');
      const apiToken = await prisma.apiToken.findUnique({
        where: { tokenHash: hashApiToken(token) },
        include: { user: { select: { id: true, email: true } } }
      });
      if (!apiToken) return reject(401, 'Unauthorized');
      if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
        return reject(401, 'Unauthorized');
      }
      const scopes = Array.isArray(apiToken.scopes) ? (apiToken.scopes as string[]) : [];
      if (!scopes.includes('exec')) return reject(403, 'Forbidden');
      userId = apiToken.user.id;
      actorEmail = apiToken.user.email;
      prisma.apiToken
        .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }
    if (!userId) return reject(401, 'Unauthorized');
    if (analytics.configured && !(await analytics.isFeatureEnabled('greenhouse', userId))) {
      return reject(404, 'Not Found');
    }

    const sandboxId = match[1];
    const authorize = async (): Promise<{ ok: boolean; ref?: SandboxRef }> => {
      const row = await prisma.sandbox.findUnique({
        where: { id: sandboxId },
        select: { ...SANDBOX_REF_SELECT, status: true }
      });
      if (!row) return { ok: false };
      if (row.userId !== userId) {
        const actor = await prisma.user.findUnique({
          where: { id: userId },
          select: { isSuperAdmin: true }
        });
        if (!actor?.isSuperAdmin) return { ok: false };
      }
      if (row.status !== 'running') return { ok: false };
      return { ok: true, ref: refOf(row) };
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

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}
