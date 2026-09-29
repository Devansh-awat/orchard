import * as http from 'http';
import * as net from 'net';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { jwtVerify, SignJWT } from 'jose';
import { PassThrough } from 'stream';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { hashApiToken } from '../auth/api-tokens.service';
import { requestAuthStorage } from '../auth/request-context';
import { assertBrowserSession } from '../auth/session-jwt';
import { resolveNamespaceScope } from '../projects/namespace-scope';
import { loadKubeConfigFromPathOrBase64 } from './kubeconfig';
import {
  DETACH_GRACE_MS,
  ExecSessionDirectory,
  RingBuffer,
  SESSION_LIMIT_CODE,
  SESSION_TAKEOVER_CODE,
  makeHandle,
  oldestDetachedBeyondCap,
  overLimit,
  parseHandle,
  replicaId,
  sessions,
  track,
  untrack,
  type AttachReason,
  type ExecSession
} from './exec-sessions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ConnectionContext {
  kc: k8s.KubeConfig;
  namespace: string;
  podName: string;
  container: string;
  userId: string;
  projectId: string;
  organizationId: string;
  recheckAuth: () => Promise<boolean>;
  sessionId: string | undefined;
  requested: string;
  isProxyHop: boolean;
  logAudit: (action: string, metadata?: Record<string, unknown>) => void;
}

type DestroyCause = 'exited' | 'failed' | 'revoked' | 'expired';

// Re-validation cadence for an open exec session. Short enough that revoking
// a session or demoting a user closes the shell quickly; long enough that the
// DB load is negligible per active terminal.
const RECHECK_INTERVAL_MS = 15_000;

const HEARTBEAT_MS = 25_000;

const WS_HIGH_WATER = 1024 * 1024;

const WS_LOW_WATER = 256 * 1024;

const DRAIN_POLL_MS = 50;

const FORCE_RESIZE_BOUNCE_MS = 30;

const DIRECTORY_LOOKUP_MS = 200;

const PROXY_DIAL_MS = 2_000;

const EXEC_FAILED_CODE = 4500;

const WS_MAX_PAYLOAD = 64 * 1024;

function clampReason(reason: string): string {
  return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
}

function describeExecFailure(message: string): string {
  if (/failed to load \/bin\/sh|no such file or directory/i.test(message)) {
    return 'This image has no shell, so an interactive session is not possible.';
  }
  if (/not found|NotFound/i.test(message)) {
    return 'That container is no longer running.';
  }
  return `Could not start a shell: ${message}`;
}

function shellCommand(sessionId: string): string[] {
  return [
    '/bin/sh',
    '-c',
    'export TERM=xterm-256color COLORTERM=truecolor; ' +
      `if command -v tmux >/dev/null 2>&1; then exec tmux -u new-session -A -s "orchard-${sessionId}"; fi; ` +
      'for s in bash zsh sh ash dash; do ' +
      'if command -v "$s" >/dev/null 2>&1; then exec "$s"; fi; done; exec sh'
  ];
}

function sendJson(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {}
}

function sendBytes(ws: WebSocket, text: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(Buffer.from(text), { binary: true });
  } catch {}
}

function unbind(ws: WebSocket): void {
  ws.removeAllListeners('message');
  ws.removeAllListeners('close');
  ws.removeAllListeners('error');
  ws.removeAllListeners('pong');
}

function relayableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

class ResizableOutput extends PassThrough {
  columns = 80;

  rows = 24;

  setSize(columns: number, rows: number): void {
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return;
    const nextCols = Math.max(1, Math.min(1000, Math.floor(columns)));
    const nextRows = Math.max(1, Math.min(1000, Math.floor(rows)));
    if (nextCols === this.columns && nextRows === this.rows) return;
    this.columns = nextCols;
    this.rows = nextRows;
    this.emit('resize');
  }

  forceResize(columns: number, rows: number): void {
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return;
    const cols = Math.max(1, Math.min(1000, Math.floor(columns)));
    const target = Math.max(1, Math.min(1000, Math.floor(rows)));
    this.columns = cols;
    this.rows = Math.max(1, target - 1);
    this.emit('resize');
    setTimeout(() => {
      this.rows = target;
      this.emit('resize');
    }, FORCE_RESIZE_BOUNCE_MS);
  }
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

/**
 * Raw WebSocket server for interactive pod terminals.
 * Handles: ws(s)://host/apiv1/pods/:podName/exec?namespace=...&container=...
 *
 * Auth: verifies session cookie JWT, resolves namespace→project, and requires
 * project-edit on that project. Viewers and non-members are rejected. Every
 * connect is audit-logged.
 */
export function attachTerminalWebSocket(server: http.Server, app: INestApplication) {
  const prisma = app.get(PrismaService);
  const authz = app.get(AuthorizationService);
  const sessionsService = app.get(SessionsService);
  const audit = app.get(AuditService);

  const wss = new WebSocket.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  const kc = new k8s.KubeConfig();
  const base64Value = process.env.KUBECONFIG_BASE64;
  const configPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;

  try {
    if (base64Value) {
      kc.loadFromString(Buffer.from(base64Value, 'base64').toString('utf-8'));
    } else if (configPath) {
      loadKubeConfigFromPathOrBase64(kc, configPath);
    } else {
      kc.loadFromDefault();
    }
  } catch (err) {
    console.warn(
      '[Terminal] kubeconfig unavailable — pod exec terminal disabled:',
      (err as Error).message
    );
  }

  const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET || '');
  const directory = new ExecSessionDirectory((m) => console.warn(`[Terminal] ${m}`));
  const proxyEnabled = process.env.EXEC_SESSION_PROXY !== 'false';
  const selfAddr = process.env.POD_IP ? `${process.env.POD_IP}:${process.env.PORT || 3001}` : null;

  server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/apiv1\/pods\/([^/]+)\/exec$/);
    if (!match) return; // Not our route — let other handlers deal with it

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    const podName = match[1];
    const namespace = url.searchParams.get('namespace') || '';
    const container = url.searchParams.get('container') || '';
    const requested = url.searchParams.get('session') || '';
    if (!namespace) return reject(400, 'Bad Request');

    let userId: string | undefined;
    let actorEmail: string | undefined;
    let isProxyHop = false;
    // C-1: when an API token authenticates this WS, its project allow-list
    // must constrain the authz checks below. The HTTP API plumbs this via
    // SuperAdminGuard → requestAuthStorage; this gateway bypasses that guard
    // and must enter the context itself, otherwise resolveProjectAccess sees
    // an empty store and skips the allow-list entirely.
    let tokenAuthCtx: {
      apiTokenId: string;
      tokenScopes: string[];
      tokenProjectIds: string[];
    } | null = null;
    let sessionIdForRecheck: string | undefined;
    let sessionOrgScope: string | undefined;

    const proxyHeader = req.headers['x-orchard-exec-proxy'];
    if (typeof proxyHeader === 'string' && proxyHeader) {
      try {
        const { payload } = await jwtVerify(proxyHeader, jwtSecret, { audience: 'exec-proxy' });
        const sub = payload.sub;
        const sid = payload.sid;
        const parsed = requested ? parseHandle(requested) : null;
        if (typeof sub !== 'string' || typeof sid !== 'string' || !parsed || parsed.id !== sid) {
          return reject(401, 'Unauthorized');
        }
        userId = sub;
        isProxyHop = true;
        if (typeof payload.sessionId === 'string' && payload.sessionId) {
          sessionIdForRecheck = payload.sessionId;
        }
      } catch {
        return reject(401, 'Unauthorized');
      }
    }

    const cookies = parseCookies(req.headers.cookie || '');
    const authHeader = req.headers['authorization'];
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
    const token = cookies['session_token'] || bearer;

    if (!isProxyHop) {
      if (!token) return reject(401, 'Unauthorized');
      try {
        const { payload } = await jwtVerify(token, jwtSecret);

        // Require sessionId binding so revocation actually works for exec.
        const sessionId = assertBrowserSession(payload);
        const sessionValid = await sessionsService.validateSession(sessionId);
        if (!sessionValid) return reject(401, 'Unauthorized');
        sessionIdForRecheck = sessionId;
        sessionOrgScope = payload.orgScope as string | undefined;

        // Resolve sub → internal user UUID (sub may be externalAuthId for OAuth).
        let dbUserId = payload.sub as string;
        const externalAuthId = (payload.externalAuthId ?? payload.hackClubId) as string | undefined;
        if (externalAuthId) {
          const dbUser = await prisma.user.findUnique({
            where: { externalAuthId },
            select: { id: true, email: true }
          });
          if (dbUser) {
            dbUserId = dbUser.id;
            actorEmail = dbUser.email;
          }
        }
        if (!UUID_RE.test(dbUserId)) {
          // sub is a Hack Club ID, not a UUID. Try one more lookup; if it
          // still misses, refuse rather than let downstream membership checks
          // run with a non-UUID and silently fail closed in confusing ways.
          const dbUser = await prisma.user.findFirst({
            where: { externalAuthId: dbUserId },
            select: { id: true, email: true }
          });
          if (!dbUser) return reject(401, 'Unauthorized');
          dbUserId = dbUser.id;
          actorEmail = dbUser.email;
        }
        if (!actorEmail) {
          const u = await prisma.user.findUnique({
            where: { id: dbUserId },
            select: { email: true }
          });
          actorEmail = u?.email;
        }
        userId = dbUserId;
      } catch {
        // JWT failed — try API token. API tokens are also bound to a user; treat them
        // as session-revocation-equivalent only if they have not expired.
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
        if (!scopes.includes('exec')) {
          // API tokens default to read-only. Pod exec is one of the most
          // dangerous capabilities; require it to be explicitly granted at
          // token creation rather than inherited from the owning user's role.
          return reject(403, 'Forbidden');
        }
        const restrictedProjectIds = Array.isArray(apiToken.restrictedProjectIds)
          ? (apiToken.restrictedProjectIds as string[])
          : [];
        tokenAuthCtx = {
          apiTokenId: apiToken.id,
          tokenScopes: scopes,
          tokenProjectIds: restrictedProjectIds
        };
        userId = apiToken.user.id;
        actorEmail = apiToken.user.email;
        prisma.apiToken
          .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
          .catch(() => {});
      }
    }

    if (!userId) return reject(401, 'Unauthorized');
    const principal = userId;

    // Resolve namespace → project (directly, or through the environment that
    // owns it), then require project-edit (blocks viewers + non-members).
    const scope = await resolveNamespaceScope(prisma, namespace);
    if (!scope) return reject(404, 'Not Found');
    const project = { id: scope.projectId, organizationId: scope.organizationId };

    // Run authz inside the token context so requestAuthStorage-based scope
    // filtering in AuthorizationService applies. Session auth gets an empty
    // context, matching what SuperAdminGuard publishes for JWT-auth requests.
    const runWithAuthCtx = <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, rejectPromise) => {
        requestAuthStorage.run(tokenAuthCtx ?? { sessionOrgId: sessionOrgScope }, () => {
          fn().then(resolve, rejectPromise);
        });
      });

    try {
      await runWithAuthCtx(() => authz.requireProjectEdit(project.id, principal, 'exec into pod'));
    } catch {
      // 404 to non-members so we don't leak project existence.
      return reject(404, 'Not Found');
    }

    const logAudit = (action: string, metadata: Record<string, unknown> = {}) => {
      audit
        .log({
          action,
          actorUserId: principal,
          actorEmail: actorEmail ?? null,
          organizationId: project.organizationId,
          projectId: project.id,
          targetType: 'pod',
          targetId: podName,
          targetLabel: podName,
          metadata: { namespace, container: container || null, ...metadata }
        })
        .catch(() => {});
    };

    const recheckAuth = (): Promise<boolean> =>
      runWithAuthCtx(async () => {
        try {
          if (sessionIdForRecheck) {
            const valid = await sessionsService.validateSession(sessionIdForRecheck);
            if (!valid) return false;
          }
          await authz.requireProjectEdit(project.id, principal, 'exec into pod');
          return true;
        } catch {
          return false;
        }
      });

    socket.setNoDelay(true);

    const ctx: ConnectionContext = {
      kc,
      namespace,
      podName,
      container,
      userId: principal,
      projectId: project.id,
      organizationId: project.organizationId,
      recheckAuth,
      sessionId: sessionIdForRecheck,
      requested,
      isProxyHop,
      logAudit
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      void resolveAndAttach(ws, ctx);
    });
  });

  async function resolveAndAttach(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    const parsed = ctx.requested ? parseHandle(ctx.requested) : null;
    if (!parsed) {
      createSession(ws, ctx, ctx.requested ? 'expired' : 'new');
      return;
    }
    if (parsed.replica === replicaId) {
      const existing = sessions.get(parsed.id);
      if (!existing) {
        createSession(ws, ctx, 'expired', parsed.id);
        return;
      }
      if (
        existing.ownerUserId !== ctx.userId ||
        existing.namespace !== ctx.namespace ||
        existing.podName !== ctx.podName ||
        existing.container !== ctx.container
      ) {
        ctx.logAudit('deployment.pod.exec.denied', { session: parsed.id });
        createSession(ws, ctx, 'denied');
        return;
      }
      if (existing.state === 'dying' || existing.exited) {
        createSession(ws, ctx, 'expired', parsed.id);
        return;
      }
      ctx.logAudit('deployment.pod.exec.reattach', { session: parsed.id });
      attachSession(existing, ws, ctx, 'resumed');
      return;
    }
    if (!ctx.isProxyHop && proxyEnabled) {
      const entry = await withTimeout(directory.get(parsed.id), DIRECTORY_LOOKUP_MS, null);
      if (
        entry &&
        entry.replica === parsed.replica &&
        entry.ownerUserId === ctx.userId &&
        entry.namespace === ctx.namespace &&
        entry.podName === ctx.podName &&
        entry.container === ctx.container
      ) {
        const proxied = await proxyToOwner(ws, entry.addr, ctx, parsed.id);
        if (proxied) return;
      }
    }
    createSession(ws, ctx, 'moved', parsed.id);
  }

  function createSession(
    ws: WebSocket,
    ctx: ConnectionContext,
    reason: AttachReason,
    reuseId?: string
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (overLimit(ctx.userId)) {
      sendBytes(ws, '\r\n\x1b[2K\x1b[31mToo many open shells. Close one and try again.\x1b[0m\r\n');
      ws.close(SESSION_LIMIT_CODE, 'too many sessions');
      return;
    }

    const id = reuseId && !sessions.has(reuseId) ? reuseId : randomUUID();
    const stdin = new PassThrough();
    const stdout = new ResizableOutput();
    const stderr = new PassThrough();

    const session: ExecSession = {
      id,
      handle: makeHandle(id),
      ownerUserId: ctx.userId,
      namespace: ctx.namespace,
      podName: ctx.podName,
      container: ctx.container,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      upstream: null,
      stdin,
      stdout,
      stderr,
      ring: new RingBuffer(),
      browser: null,
      state: 'attached',
      createdAt: Date.now(),
      detachedAt: null,
      graceTimer: null,
      recheckTimer: null,
      heartbeat: null,
      recheckAuth: ctx.recheckAuth,
      paused: false,
      exited: false
    };
    track(session);
    publish(session);
    ctx.logAudit('deployment.pod.exec', { session: id, reason });

    session.recheckTimer = setInterval(() => {
      void session.recheckAuth().then((ok) => {
        if (!ok) destroySession(session, 'revoked');
      });
    }, RECHECK_INTERVAL_MS);

    forward(session, stdout);
    forward(session, stderr);
    attachSession(session, ws, ctx, reason);

    const exec = new k8s.Exec(ctx.kc);
    exec
      .exec(
        ctx.namespace,
        ctx.podName,
        ctx.container,
        shellCommand(id),
        stdout,
        stderr,
        stdin,
        true,
        (status) => {
          if (status.status === 'Success') {
            destroySession(session, 'exited');
            return;
          }
          destroySession(session, 'failed', describeExecFailure(status.message ?? ''));
        }
      )
      .then((up) => {
        if (session.state === 'dying') {
          try {
            up.close();
          } catch {}
          return;
        }
        session.upstream = up;
        const raw = (up as unknown as { _socket?: net.Socket })._socket;
        raw?.setNoDelay?.(true);
        up.on('close', () => {
          if (!session.exited) destroySession(session, 'exited');
        });
      })
      .catch((err) => {
        destroySession(session, 'failed', describeExecFailure(err?.message ?? 'exec failed'));
      });
  }

  function attachSession(
    session: ExecSession,
    ws: WebSocket,
    ctx: ConnectionContext,
    reason: AttachReason
  ): void {
    const incumbent = session.browser;
    if (incumbent && incumbent !== ws) {
      unbind(incumbent);
      try {
        incumbent.close(SESSION_TAKEOVER_CODE, 'session moved');
      } catch {}
    }
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    session.browser = ws;
    session.state = 'attached';
    session.detachedAt = null;
    session.recheckAuth = ctx.recheckAuth;

    const resumed = reason === 'resumed';
    const truncated = session.ring.truncated;
    const replay = resumed ? session.ring.drain() : Buffer.alloc(0);
    session.ring.truncated = false;

    sendJson(ws, {
      type: 'attached',
      handle: session.handle,
      resumed,
      reason,
      replayedBytes: replay.length,
      truncated: resumed && truncated
    });
    if (resumed) {
      if (truncated) {
        sendBytes(ws, '\r\n\x1b[2K\x1b[90m--- output truncated while disconnected ---\x1b[0m\r\n');
      }
      if (replay.length > 0) ws.send(replay, { binary: true });
    }
    if (session.paused && session.upstream) {
      session.paused = false;
      session.upstream.resume();
    }

    ws.on('message', (data: WebSocket.Data, isBinary?: boolean) => {
      if (session.browser !== ws) return;
      if (isBinary === false || typeof data === 'string') {
        const msg = typeof data === 'string' ? data : data.toString();
        let frame: { type?: unknown; cols?: unknown; rows?: unknown; force?: unknown } | null =
          null;
        try {
          frame = JSON.parse(msg);
        } catch {}
        if (frame && typeof frame === 'object' && 'type' in frame) {
          if (frame.type === 'resize') {
            if (frame.force === true) {
              session.stdout.forceResize(Number(frame.cols), Number(frame.rows));
            } else {
              session.stdout.setSize(Number(frame.cols), Number(frame.rows));
            }
          }
          return;
        }
        writeStdin(session, ws, msg);
        return;
      }
      writeStdin(session, ws, data as Buffer);
    });

    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.heartbeat = setInterval(() => {
      if (session.browser !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {}
    }, HEARTBEAT_MS);

    const onGone = () => {
      if (session.browser !== ws) return;
      detachSession(session);
    };
    ws.on('close', onGone);
    ws.on('error', onGone);
  }

  function writeStdin(session: ExecSession, ws: WebSocket, chunk: string | Buffer): void {
    if (session.stdin.write(chunk)) return;
    ws.pause();
    session.stdin.once('drain', () => {
      if (session.browser === ws && ws.readyState === WebSocket.OPEN) ws.resume();
    });
  }

  function detachSession(session: ExecSession): void {
    if (session.state === 'dying') return;
    session.browser = null;
    session.state = 'detached';
    session.detachedAt = Date.now();
    if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => destroySession(session, 'expired'), DETACH_GRACE_MS);
    publish(session);
    for (const stale of oldestDetachedBeyondCap(session.ownerUserId)) {
      destroySession(stale, 'expired');
    }
  }

  function destroySession(session: ExecSession, cause: DestroyCause, detail?: string): void {
    if (session.state === 'dying') return;
    session.state = 'dying';
    session.exited = true;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.recheckTimer) clearInterval(session.recheckTimer);
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.graceTimer = null;
    session.recheckTimer = null;
    session.heartbeat = null;

    const ws = session.browser;
    session.browser = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      unbind(ws);
      switch (cause) {
        case 'exited':
          ws.close(1000, 'exited');
          break;
        case 'failed':
          sendBytes(ws, `\r\n\x1b[2K\x1b[31m${detail ?? 'exec failed'}\x1b[0m\r\n`);
          ws.close(EXEC_FAILED_CODE, clampReason(detail ?? 'exec failed'));
          break;
        case 'revoked':
          sendBytes(ws, '\r\nSession terminated: access revoked.\r\n');
          ws.close(4401, 'access revoked');
          break;
        case 'expired':
          ws.close(1000, 'expired');
          break;
      }
    }

    try {
      session.stdin.end();
    } catch {}
    try {
      session.upstream?.close();
    } catch {}
    untrack(session);
    void directory.del(session.id);
  }

  function forward(session: ExecSession, source: PassThrough): void {
    source.on('data', (chunk: Buffer) => {
      const ws = session.browser;
      if (session.state !== 'attached' || !ws || ws.readyState !== WebSocket.OPEN) {
        if (session.state === 'detached') session.ring.push(chunk);
        return;
      }
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount <= WS_HIGH_WATER) return;
      const pausable = session.upstream ?? source;
      pausable.pause();
      session.paused = true;
      const drain = setInterval(() => {
        const current = session.browser;
        if (
          session.state !== 'attached' ||
          !current ||
          current.readyState !== WebSocket.OPEN ||
          current.bufferedAmount <= WS_LOW_WATER
        ) {
          clearInterval(drain);
          session.paused = false;
          pausable.resume();
        }
      }, DRAIN_POLL_MS);
    });
  }

  function publish(session: ExecSession): void {
    if (!selfAddr) return;
    void directory.set(
      session.id,
      {
        replica: replicaId,
        addr: selfAddr,
        ownerUserId: session.ownerUserId,
        namespace: session.namespace,
        podName: session.podName,
        container: session.container
      },
      DETACH_GRACE_MS + 60_000
    );
  }

  async function proxyToOwner(
    client: WebSocket,
    addr: string,
    ctx: ConnectionContext,
    sessionId: string
  ): Promise<boolean> {
    let token: string;
    try {
      token = await new SignJWT({
        sid: sessionId,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {})
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(ctx.userId)
        .setAudience('exec-proxy')
        .setIssuedAt()
        .setExpirationTime('30s')
        .sign(jwtSecret);
    } catch {
      return false;
    }
    const target = new URL(`ws://${addr}/apiv1/pods/${encodeURIComponent(ctx.podName)}/exec`);
    target.searchParams.set('namespace', ctx.namespace);
    target.searchParams.set('container', ctx.container);
    target.searchParams.set('session', ctx.requested);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const upstream = new WebSocket(target.toString(), {
        headers: { 'x-orchard-exec-proxy': token },
        handshakeTimeout: PROXY_DIAL_MS
      });
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      upstream.on('open', () => {
        settle(true);
        client.on('message', (data: WebSocket.Data, isBinary?: boolean) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data as Buffer, { binary: isBinary !== false });
          }
        });
        client.on('close', () => {
          try {
            upstream.close();
          } catch {}
        });
        client.on('error', () => {
          try {
            upstream.close();
          } catch {}
        });
      });
      upstream.on('message', (data: WebSocket.Data, isBinary?: boolean) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data as Buffer, { binary: isBinary !== false });
        }
      });
      upstream.on('close', (code, reason) => {
        if (!settled) {
          settle(false);
          return;
        }
        if (client.readyState === WebSocket.OPEN) {
          client.close(relayableCloseCode(code), reason.toString().slice(0, 120));
        }
      });
      upstream.on('error', () => {
        if (!settled) {
          settle(false);
          return;
        }
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'proxy error');
      });
    });
  }
}
