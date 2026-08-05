import * as http from 'http';
import * as net from 'net';
import * as WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { jwtVerify } from 'jose';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { hashApiToken } from '../auth/api-tokens.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SandboxK8sService } from './sandbox-k8s.service';
import { sandboxFeatureEnabled } from './sandbox-enabled.guard';

const ROUTE_RE = /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/(ssh|terminal)$/;
const RECHECK_INTERVAL_MS = 15_000;
const ACTIVITY_INTERVAL_MS = 60_000;
const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1024 * 1024;

export function attachSandboxSshWebSocket(server: http.Server, app: INestApplication) {
  const prisma = app.get(PrismaService);
  const sessions = app.get(SessionsService);
  const audit = app.get(AuditService);
  const kubernetes = app.get(KubernetesService);
  const sandboxK8s = app.get(SandboxK8sService);
  const analytics = app.get(AnalyticsService);

  const wss = new WebSocket.Server({ noServer: true });
  const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET || '');

  server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(ROUTE_RE);
    if (!match) return;

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    if (!sandboxFeatureEnabled()) return reject(404, 'Not Found');

    const cookies = parseCookies(req.headers.cookie || '');
    const authHeader = req.headers['authorization'];
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    const token = cookies['session_token'] || bearer;
    if (!token) return reject(401, 'Unauthorized');

    let userId: string | undefined;
    let actorEmail: string | undefined;
    let sessionIdForRecheck: string | undefined;
    try {
      const { payload } = await jwtVerify(token, jwtSecret);
      const sessionId = payload.sessionId as string | undefined;
      if (!sessionId) return reject(401, 'Unauthorized');
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
            ...(externalAuthId ? [{ externalAuthId }] : []),
          ],
        },
        select: { id: true, email: true },
      });
      if (!dbUser) return reject(401, 'Unauthorized');
      userId = dbUser.id;
      actorEmail = dbUser.email;
    } catch {
      if (!token.startsWith('orch_')) return reject(401, 'Unauthorized');
      const apiToken = await prisma.apiToken.findUnique({
        where: { tokenHash: hashApiToken(token) },
        include: { user: { select: { id: true, email: true } } },
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
    const kind = match[2];
    const authorize = async (): Promise<{ ok: boolean; podName?: string }> => {
      const row = await prisma.sandbox.findUnique({
        where: { id: sandboxId },
        select: { userId: true, status: true, podName: true },
      });
      if (!row) return { ok: false };
      if (row.userId !== userId) {
        const actor = await prisma.user.findUnique({
          where: { id: userId },
          select: { isSuperAdmin: true },
        });
        if (!actor?.isSuperAdmin) return { ok: false };
      }
      if (row.status !== 'running') return { ok: false };
      return { ok: true, podName: row.podName };
    };

    const authzResult = await authorize();
    if (!authzResult.ok) return reject(404, 'Not Found');

    let podIp: string | null = null;
    if (kind === 'ssh') {
      try {
        podIp = await sandboxK8s.resolvePodIp(sandboxId, authzResult.podName!);
      } catch {
        podIp = null;
      }
    }
    const tunnelMode = process.env.SANDBOX_TUNNEL_MODE === 'portforward' ? 'portforward' : 'direct';
    if (kind === 'ssh' && tunnelMode === 'direct' && !podIp) return reject(502, 'Bad Gateway');

    audit
      .log({
        action: 'sandbox.ssh.connect',
        actorUserId: userId,
        actorEmail: actorEmail ?? null,
        targetType: 'sandbox',
        targetId: sandboxId,
        metadata: { podName: authzResult.podName ?? null },
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      if (kind === 'terminal') {
        handleShellSession(
          ws, kubernetes, sandboxK8s.namespace, sandboxId, prisma, recheckAuth,
        );
      } else if (tunnelMode === 'portforward') {
        handlePortForwardTunnel(
          ws, kubernetes, sandboxK8s.namespace, sandboxId, prisma, recheckAuth,
        );
      } else {
        handleDirectTunnel(ws, podIp!, sandboxId, prisma, recheckAuth);
      }
    });
  });
}

function attachLifecycle(
  ws: WebSocket,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>,
  teardown: () => void,
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

function handleShellSession(
  ws: WebSocket,
  kubernetes: KubernetesService,
  namespace: string,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>,
) {
  void (async () => {
    if (!kubernetes.kc) {
      ws.close(1011, 'kubernetes unavailable');
      return;
    }
    const core = kubernetes.kc.makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandboxId}`,
    );
    const pod = pods.body.items.find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      ws.close(1011, 'sandbox pod not found');
      return;
    }
    const { PassThrough } = await import('stream');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    attachLifecycle(ws, sandboxId, prisma, recheckAuth, () => stdin.end());

    const forward = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };
    stdout.on('data', forward);
    stderr.on('data', forward);

    ws.on('message', (data: WebSocket.Data) => {
      const text = typeof data === 'string' ? data : data.toString();
      try {
        const parsed = JSON.parse(text);
        if (parsed?.type === 'resize') return;
      } catch {}
      stdin.write(text);
    });
    ws.on('close', () => stdin.end());

    try {
      const exec = new k8s.Exec(kubernetes.kc);
      await exec.exec(
        namespace,
        pod.metadata.name,
        'sandbox',
        ['/bin/sh', '-c', 'cd /persist/home; exec su -l dev'],
        stdout,
        stderr,
        stdin,
        true,
        (status) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, status.status === 'Success' ? 'exited' : 'shell closed');
          }
        },
      );
    } catch (e: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\nFailed to open a shell: ${e?.message}\r\n`);
        ws.close(1011, 'shell error');
      }
    }
  })();
}

function handleDirectTunnel(
  ws: WebSocket,
  podIp: string,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>,
) {
  const socket = net.connect(22, podIp);
  socket.setNoDelay(true);

  attachLifecycle(ws, sandboxId, prisma, recheckAuth, () => socket.destroy());

  socket.on('data', (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > WS_HIGH_WATER) {
      socket.pause();
      const drainCheck = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(drainCheck);
          return;
        }
        if (ws.bufferedAmount < WS_LOW_WATER) {
          clearInterval(drainCheck);
          socket.resume();
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
    const ok = socket.write(buf);
    if (!ok) {
      ws.pause();
      socket.once('drain', () => ws.resume());
    }
  });

  socket.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'connection closed');
  });
  socket.on('error', (err) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message.slice(0, 120));
  });
  ws.on('close', () => socket.destroy());
  ws.on('error', () => socket.destroy());
}

function handlePortForwardTunnel(
  ws: WebSocket,
  kubernetes: KubernetesService,
  namespace: string,
  sandboxId: string,
  prisma: PrismaService,
  recheckAuth: () => Promise<boolean>,
) {
  void (async () => {
    if (!kubernetes.kc) {
      ws.close(1011, 'kubernetes unavailable');
      return;
    }
    const core = kubernetes.kc.makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandboxId}`,
    );
    const pod = pods.body.items.find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      ws.close(1011, 'sandbox pod not found');
      return;
    }
    const forward = new k8s.PortForward(kubernetes.kc);
    const duplex = new net.Socket({ allowHalfOpen: false });
    void duplex;
    const { PassThrough } = await import('stream');
    const input = new PassThrough();
    const output = new PassThrough();

    attachLifecycle(ws, sandboxId, prisma, recheckAuth, () => {
      input.end();
      ws.close(1000, 'connection closed');
    });

    output.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });
    ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      input.write(buf);
    });
    ws.on('close', () => input.end());

    try {
      await forward.portForward(namespace, pod.metadata.name, [22], output, null, input);
    } catch (err: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, String(err?.message || 'port forward failed').slice(0, 120));
      }
    }
  })();
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}
