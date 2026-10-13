import * as http from 'http';
import * as net from 'net';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { jwtVerify, SignJWT } from 'jose';
import { PassThrough, type Writable } from 'stream';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { hashApiToken } from '../auth/api-tokens.service';
import { assertBrowserSession } from '../auth/session-jwt';
import { originAllowed, platformOrigins } from '../auth/upgrade-auth';
import type { PtyHandle } from './pty';
import {
  DETACH_GRACE_MS,
  ExecSessionDirectory,
  SESSION_LIMIT_CODE,
  SESSION_TAKEOVER_CODE,
  clampTerminalSize,
  directoryEntry,
  entryTargetKey,
  makeHandle,
  oldestDetachedBeyondCap,
  overLimit,
  parseHandle,
  replicaId,
  sessions,
  targetKey,
  track,
  untrack,
  type AttachReason,
  type ExecSession,
  type ExecTarget
} from './exec-sessions';
import { SessionScreen } from './exec-screen';
import {
  CLEAR_SCREEN_AND_SCROLLBACK,
  parseClientFrame,
  parseHandshake,
  rejectionCloseCode,
  statusBytes,
  statusFrame,
  type Proto,
  type StatusKind
} from './exec-protocol';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RECHECK_INTERVAL_MS = 15_000;

const HEARTBEAT_MS = 25_000;

const ACTIVITY_INTERVAL_MS = 60_000;

const WS_HIGH_WATER = 1024 * 1024;

const WS_LOW_WATER = 256 * 1024;

const DRAIN_POLL_MS = 50;

const DIRECTORY_LOOKUP_MS = 200;

const PROXY_DIAL_MS = 2_000;

const EXEC_FAILED_CODE = 4500;

const WS_MAX_PAYLOAD = 64 * 1024;

export interface TokenAuthContext {
  apiTokenId: string;
  tokenScopes: string[];
  tokenProjectIds: string[];
}

export interface EngineAuth {
  userId: string;
  actorEmail: string | null;
  browserSessionId: string | undefined;
  sessionOrgScope: string | undefined;
  tokenAuthCtx: TokenAuthContext | null;
  isProxyHop: boolean;
}

export type Rejection = { reject: number; message: string };

export interface ResolvedExecTarget {
  target: ExecTarget;
  recheckAuth: () => Promise<boolean>;
  logAudit: (action: string, metadata?: Record<string, unknown>) => void;
}

export interface ExecRouteHooks {
  route: RegExp;
  validate?(match: RegExpMatchArray, url: URL): Rejection | null;
  preflight?(): Promise<Rejection | null>;
  authenticate?(req: http.IncomingMessage, deps: EngineDeps): Promise<EngineAuth | Rejection>;
  resolveTarget(
    match: RegExpMatchArray,
    url: URL,
    auth: EngineAuth
  ): Promise<ResolvedExecTarget | Rejection>;
  open(
    target: ExecTarget,
    sessionId: string,
    size: { cols: number; rows: number }
  ): PtyHandle | Promise<PtyHandle>;
  proxyPath(target: ExecTarget): { path: string; params: Record<string, string> };
  onActivity?(target: ExecTarget): void;
  audit: { open: string; reattach: string; denied: string };
  describeFailure?(message: string): string;
}

export type UpgradeSkip = (req: http.IncomingMessage) => boolean;

export interface EngineDeps {
  prisma: PrismaService;
  sessions: SessionsService;
  jwtSecret: Uint8Array;
  skipUpgrade?: UpgradeSkip;
}

interface ConnectionContext {
  hooks: ExecRouteHooks;
  target: ExecTarget;
  targetKey: string;
  userId: string;
  recheckAuth: () => Promise<boolean>;
  browserSessionId: string | undefined;
  sessionOrgScope: string | undefined;
  tokenAuthCtx: TokenAuthContext | null;
  requested: string;
  isProxyHop: boolean;
  proto: Proto;
  cols: number;
  rows: number;
  logAudit: (action: string, metadata?: Record<string, unknown>) => void;
}

type DestroyCause = 'exited' | 'failed' | 'revoked' | 'expired';

function isRejection(value: unknown): value is Rejection {
  return !!value && typeof value === 'object' && 'reject' in value;
}

function clampReason(reason: string): string {
  return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
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

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

export async function authenticateUpgrade(
  req: http.IncomingMessage,
  deps: EngineDeps
): Promise<EngineAuth | Rejection> {
  const unauthorized: Rejection = { reject: 401, message: 'Unauthorized' };
  const cookies = parseCookies(req.headers.cookie || '');
  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
  const token = cookies['session_token'] || bearer;
  if (!token) return unauthorized;
  if (cookies['session_token'] && !originAllowed(req.headers.origin, platformOrigins(), 'cookie')) {
    return { reject: 403, message: 'Forbidden' };
  }
  try {
    const { payload } = await jwtVerify(token, deps.jwtSecret);
    const sessionId = assertBrowserSession(payload);
    const sessionValid = await deps.sessions.validateSession(sessionId);
    if (!sessionValid) return unauthorized;
    let actorEmail: string | null = null;
    let dbUserId = payload.sub as string;
    const externalAuthId = (payload.externalAuthId ?? payload.hackClubId) as string | undefined;
    if (externalAuthId) {
      const dbUser = await deps.prisma.user.findUnique({
        where: { externalAuthId },
        select: { id: true, email: true }
      });
      if (dbUser) {
        dbUserId = dbUser.id;
        actorEmail = dbUser.email;
      }
    }
    if (!UUID_RE.test(dbUserId)) {
      const dbUser = await deps.prisma.user.findFirst({
        where: { externalAuthId: dbUserId },
        select: { id: true, email: true }
      });
      if (!dbUser) return unauthorized;
      dbUserId = dbUser.id;
      actorEmail = dbUser.email;
    }
    if (!actorEmail) {
      const u = await deps.prisma.user.findUnique({
        where: { id: dbUserId },
        select: { email: true }
      });
      actorEmail = u?.email ?? null;
    }
    return {
      userId: dbUserId,
      actorEmail,
      browserSessionId: sessionId,
      sessionOrgScope: payload.orgScope as string | undefined,
      tokenAuthCtx: null,
      isProxyHop: false
    };
  } catch {
    if (!token.startsWith('orch_')) return unauthorized;
    const apiToken = await deps.prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(token) },
      include: { user: { select: { id: true, email: true } } }
    });
    if (!apiToken) return unauthorized;
    if (apiToken.expiresAt && apiToken.expiresAt < new Date()) return unauthorized;
    const scopes = Array.isArray(apiToken.scopes) ? (apiToken.scopes as string[]) : [];
    if (!scopes.includes('exec')) return { reject: 403, message: 'Forbidden' };
    const restrictedProjectIds = Array.isArray(apiToken.restrictedProjectIds)
      ? (apiToken.restrictedProjectIds as string[])
      : [];
    deps.prisma.apiToken
      .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return {
      userId: apiToken.user.id,
      actorEmail: apiToken.user.email,
      browserSessionId: undefined,
      sessionOrgScope: undefined,
      tokenAuthCtx: {
        apiTokenId: apiToken.id,
        tokenScopes: scopes,
        tokenProjectIds: restrictedProjectIds
      },
      isProxyHop: false
    };
  }
}

export const PROXY_HOP_TYPE = 'exec-proxy';

export async function signProxyHopToken(
  secret: Uint8Array,
  hop: {
    sid: string;
    userId: string;
    browserSessionId: string | undefined;
    sessionOrgScope: string | undefined;
    tokenAuthCtx: TokenAuthContext | null;
  }
): Promise<string> {
  return new SignJWT({
    type: PROXY_HOP_TYPE,
    sid: hop.sid,
    ...(hop.browserSessionId ? { sessionId: hop.browserSessionId } : {}),
    ...(hop.sessionOrgScope ? { orgScope: hop.sessionOrgScope } : {}),
    ...(hop.tokenAuthCtx ? { tac: hop.tokenAuthCtx } : {})
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(hop.userId)
    .setAudience(PROXY_HOP_TYPE)
    .setIssuedAt()
    .setExpirationTime('30s')
    .sign(secret);
}

function hopTokenAuthCtx(value: unknown): TokenAuthContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) =>
    Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
  return {
    apiTokenId: typeof v.apiTokenId === 'string' ? v.apiTokenId : '',
    tokenScopes: strings(v.tokenScopes),
    tokenProjectIds: strings(v.tokenProjectIds)
  };
}

export async function verifyProxyHopToken(
  header: string,
  secret: Uint8Array,
  requested: string
): Promise<EngineAuth | Rejection> {
  const { payload } = await jwtVerify(header, secret, { audience: PROXY_HOP_TYPE });
  const sub = payload.sub;
  const sid = payload.sid;
  const parsed = requested ? parseHandle(requested) : null;
  if (
    (payload.type !== undefined && payload.type !== PROXY_HOP_TYPE) ||
    typeof sub !== 'string' ||
    typeof sid !== 'string' ||
    !parsed ||
    parsed.id !== sid
  ) {
    return { reject: 401, message: 'Unauthorized' };
  }
  return {
    userId: sub,
    actorEmail: null,
    browserSessionId:
      typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined,
    sessionOrgScope: typeof payload.orgScope === 'string' ? payload.orgScope : undefined,
    tokenAuthCtx: hopTokenAuthCtx(payload.tac),
    isProxyHop: true
  };
}

export class ExecSessionEngine {
  private readonly wss = new WebSocket.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  private readonly directory = new ExecSessionDirectory((m) => console.warn(`[Terminal] ${m}`));

  private readonly proxyEnabled = process.env.EXEC_SESSION_PROXY !== 'false';

  private readonly selfAddr = process.env.POD_IP
    ? `${process.env.POD_IP}:${process.env.PORT || 3001}`
    : null;

  constructor(
    private readonly server: http.Server,
    private readonly deps: EngineDeps
  ) {}

  setSkipUpgrade(skip: UpgradeSkip): void {
    this.deps.skipUpgrade = skip;
  }

  register(hooks: ExecRouteHooks): void {
    this.server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const url = new URL(req.url || '', 'http://localhost');
      const match = url.pathname.match(hooks.route);
      if (!match) return;
      if (this.deps.skipUpgrade?.(req)) return;
      void this.handleUpgrade(hooks, req, socket, head, url, match);
    });
  }

  private async handleUpgrade(
    hooks: ExecRouteHooks,
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    url: URL,
    match: RegExpMatchArray
  ): Promise<void> {
    const proxyHeader = req.headers['x-orchard-exec-proxy'];
    const viaProxy = typeof proxyHeader === 'string' && proxyHeader.length > 0;
    const reject = (code: number, msg: string) => {
      if (viaProxy) {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          ws.close(rejectionCloseCode(code), msg);
        } catch {
          socket.destroy();
        }
      });
    };

    const requested = url.searchParams.get('session') || '';
    const handshake = parseHandshake(url.searchParams);
    const invalid = hooks.validate?.(match, url);
    if (invalid) return reject(invalid.reject, invalid.message);

    const pre = hooks.preflight ? await hooks.preflight() : null;
    if (pre) return reject(pre.reject, pre.message);
    const auth = viaProxy
      ? await this.verifyProxyHop(proxyHeader as string, requested)
      : await (hooks.authenticate ?? authenticateUpgrade)(req, this.deps);
    if (isRejection(auth)) return reject(auth.reject, auth.message);

    const resolved = await hooks
      .resolveTarget(match, url, auth)
      .catch((): Rejection => ({ reject: 404, message: 'Not Found' }));
    if (isRejection(resolved)) return reject(resolved.reject, resolved.message);

    socket.setNoDelay(true);

    const ctx: ConnectionContext = {
      hooks,
      target: resolved.target,
      targetKey: targetKey(resolved.target),
      userId: auth.userId,
      recheckAuth: resolved.recheckAuth,
      browserSessionId: auth.browserSessionId,
      sessionOrgScope: auth.sessionOrgScope,
      tokenAuthCtx: auth.tokenAuthCtx,
      requested,
      isProxyHop: auth.isProxyHop,
      proto: handshake.proto,
      cols: handshake.cols,
      rows: handshake.rows,
      logAudit: resolved.logAudit
    };

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
      void this.resolveAndAttach(ws, ctx);
    });
  }

  private async verifyProxyHop(header: string, requested: string): Promise<EngineAuth | Rejection> {
    try {
      return await verifyProxyHopToken(header, this.deps.jwtSecret, requested);
    } catch {
      return { reject: 401, message: 'Unauthorized' };
    }
  }

  private async resolveAndAttach(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    const parsed = ctx.requested ? parseHandle(ctx.requested) : null;
    if (!parsed) {
      this.createSession(ws, ctx, ctx.requested ? 'expired' : 'new');
      return;
    }
    if (parsed.replica === replicaId) {
      const existing = sessions.get(parsed.id);
      if (!existing) {
        this.createSession(ws, ctx, 'expired', parsed.id);
        return;
      }
      if (existing.ownerUserId !== ctx.userId || existing.targetKey !== ctx.targetKey) {
        ctx.logAudit(ctx.hooks.audit.denied, { session: parsed.id });
        this.createSession(ws, ctx, 'denied');
        return;
      }
      if (existing.state === 'dying' || existing.exited) {
        this.createSession(ws, ctx, 'expired', parsed.id);
        return;
      }
      ctx.logAudit(ctx.hooks.audit.reattach, { session: parsed.id, proto: ctx.proto });
      void this.attachSession(existing, ws, ctx, 'resumed');
      return;
    }
    if (!ctx.isProxyHop && this.proxyEnabled) {
      const entry = await withTimeout(this.directory.get(parsed.id), DIRECTORY_LOOKUP_MS, null);
      if (
        entry &&
        entry.replica === parsed.replica &&
        entry.ownerUserId === ctx.userId &&
        entryTargetKey(entry) === ctx.targetKey
      ) {
        const proxied = await this.proxyToOwner(ws, entry.addr, ctx, parsed.id);
        if (proxied) return;
      }
    }
    this.createSession(ws, ctx, 'moved', parsed.id);
  }

  private createSession(
    ws: WebSocket,
    ctx: ConnectionContext,
    reason: AttachReason,
    reuseId?: string
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (overLimit(ctx.userId)) {
      this.notify(
        ws,
        ctx.proto,
        'limit',
        'Too many open shells. Close one and try again.',
        'error'
      );
      ws.close(SESSION_LIMIT_CODE, 'too many sessions');
      return;
    }

    const id = reuseId && !sessions.has(reuseId) ? reuseId : randomUUID();
    const pending = new PassThrough();

    const session: ExecSession = {
      id,
      handle: makeHandle(id),
      ownerUserId: ctx.userId,
      target: ctx.target,
      targetKey: ctx.targetKey,
      upstream: null,
      stdin: pending,
      cols: ctx.cols,
      rows: ctx.rows,
      screen: new SessionScreen(ctx.cols, ctx.rows),
      proto: ctx.proto,
      reusedId: id === reuseId,
      browser: null,
      state: 'attached',
      createdAt: Date.now(),
      detachedAt: null,
      graceTimer: null,
      recheckTimer: null,
      heartbeat: null,
      activityTimer: null,
      recheckAuth: ctx.recheckAuth,
      paused: false,
      exited: false
    };
    track(session);
    this.publish(session);
    ctx.logAudit(ctx.hooks.audit.open, { session: id, reason, proto: ctx.proto });

    session.recheckTimer = setInterval(() => {
      void session.recheckAuth().then((ok) => {
        if (!ok) this.destroySession(session, 'revoked');
      });
    }, RECHECK_INTERVAL_MS);

    void this.attachSession(session, ws, ctx, reason);

    const describe = ctx.hooks.describeFailure ?? ((m: string) => `Could not start a shell: ${m}`);
    let opened: PtyHandle | Promise<PtyHandle>;
    try {
      opened = ctx.hooks.open(ctx.target, id, { cols: session.cols, rows: session.rows });
    } catch (err) {
      this.destroySession(session, 'failed', describe((err as Error)?.message ?? 'exec failed'));
      return;
    }
    const bind = (pty: PtyHandle, sync: boolean) => {
      if (session.state === 'dying') {
        pty.close();
        return;
      }
      session.upstream = pty;
      if (sync) {
        session.stdin = pty.stdin;
      } else {
        pending.pipe(pty.stdin);
        if (session.cols !== ctx.cols || session.rows !== ctx.rows) {
          pty.resize(session.cols, session.rows);
        }
      }
      this.forward(session, pty);
      void pty.exited.then((result) => {
        if (session.exited) return;
        if (result.ok) {
          this.destroySession(session, 'exited');
          return;
        }
        this.destroySession(session, 'failed', describe(result.message ?? ''));
      });
    };
    if (opened instanceof Promise) {
      opened.then(
        (pty) => bind(pty, false),
        (err) => this.destroySession(session, 'failed', describe(err?.message ?? 'exec failed'))
      );
    } else {
      bind(opened, true);
    }
  }

  private notify(
    ws: WebSocket,
    proto: Proto,
    kind: StatusKind,
    message: string,
    tone: 'quiet' | 'error' = 'quiet'
  ): void {
    if (proto === 2) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(statusFrame(kind, message));
      } catch {}
      return;
    }
    sendBytes(ws, statusBytes(message, tone));
  }

  private resizeSession(session: ExecSession, cols: number, rows: number): void {
    const next = clampTerminalSize(cols, rows);
    if (!next) return;
    if (next.cols === session.cols && next.rows === session.rows) return;
    session.cols = next.cols;
    session.rows = next.rows;
    session.upstream?.resize(next.cols, next.rows);
  }

  private async attachSession(
    session: ExecSession,
    ws: WebSocket,
    ctx: ConnectionContext,
    reason: AttachReason
  ): Promise<void> {
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
    session.browser = null;
    session.recheckAuth = ctx.recheckAuth;
    session.proto = ctx.proto;

    const resumed = reason === 'resumed';
    let snapshot: { data: string; truncated: boolean } | null = null;
    if (resumed) {
      session.screen.resize(ctx.cols, ctx.rows);
      this.resizeSession(session, ctx.cols, ctx.rows);
      snapshot = await session.screen.snapshot();
      if (ws.readyState !== WebSocket.OPEN || session.state === 'dying') return;
    }

    session.browser = ws;
    session.state = 'attached';
    session.detachedAt = null;

    if (ctx.proto === 2) {
      sendJson(ws, {
        type: 'attached',
        proto: 2,
        handle: session.handle,
        resumed,
        reason,
        reusedId: session.reusedId,
        cols: session.cols,
        rows: session.rows,
        snapshot: snapshot?.data,
        truncated: snapshot?.truncated ?? false
      });
    } else {
      sendJson(ws, {
        type: 'attached',
        handle: session.handle,
        resumed,
        reason,
        replayedBytes: snapshot?.data.length ?? 0,
        truncated: snapshot?.truncated ?? false
      });
      if (snapshot) {
        if (snapshot.truncated) sendBytes(ws, statusBytes('output truncated while disconnected'));
        if (snapshot.data.length > 0) {
          sendBytes(ws, CLEAR_SCREEN_AND_SCROLLBACK + snapshot.data);
        }
      }
    }
    if (session.paused && session.upstream) {
      session.paused = false;
      session.upstream.resume();
    }
    this.startActivity(session, ctx.hooks);

    ws.on('message', (data: WebSocket.Data, isBinary?: boolean) => {
      if (session.browser !== ws) return;
      const frame = parseClientFrame(data as Buffer | string, isBinary);
      if (frame.kind === 'resize') {
        this.resizeSession(session, frame.cols, frame.rows);
        session.screen.resize(session.cols, session.rows);
        return;
      }
      if (frame.kind === 'stdin') this.writeStdin(session, ws, frame.data);
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
      this.detachSession(session);
    };
    ws.on('close', onGone);
    ws.on('error', onGone);
  }

  private startActivity(session: ExecSession, hooks: ExecRouteHooks): void {
    if (!hooks.onActivity) return;
    const touch = () => {
      try {
        hooks.onActivity?.(session.target);
      } catch {}
    };
    touch();
    if (session.activityTimer) clearInterval(session.activityTimer);
    session.activityTimer = setInterval(() => {
      if (session.state === 'attached') touch();
    }, ACTIVITY_INTERVAL_MS);
  }

  private writeStdin(session: ExecSession, ws: WebSocket, chunk: string | Buffer): void {
    if (session.stdin.write(chunk)) return;
    ws.pause();
    (session.stdin as Writable).once('drain', () => {
      if (session.browser === ws && ws.readyState === WebSocket.OPEN) ws.resume();
    });
  }

  private detachSession(session: ExecSession): void {
    if (session.state === 'dying') return;
    session.browser = null;
    session.state = 'detached';
    session.detachedAt = Date.now();
    if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => this.destroySession(session, 'expired'), DETACH_GRACE_MS);
    this.publish(session);
    for (const stale of oldestDetachedBeyondCap(session.ownerUserId)) {
      this.destroySession(stale, 'expired');
    }
  }

  private destroySession(session: ExecSession, cause: DestroyCause, detail?: string): void {
    if (session.state === 'dying') return;
    session.state = 'dying';
    session.exited = true;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.recheckTimer) clearInterval(session.recheckTimer);
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.activityTimer) clearInterval(session.activityTimer);
    session.graceTimer = null;
    session.recheckTimer = null;
    session.heartbeat = null;
    session.activityTimer = null;

    const ws = session.browser;
    session.browser = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      unbind(ws);
      switch (cause) {
        case 'exited':
          ws.close(1000, 'exited');
          break;
        case 'failed':
          this.notify(ws, session.proto, 'failed', detail ?? 'exec failed', 'error');
          ws.close(EXEC_FAILED_CODE, clampReason(detail ?? 'exec failed'));
          break;
        case 'revoked':
          this.notify(ws, session.proto, 'revoked', 'Session terminated: access revoked.', 'error');
          ws.close(4401, 'access revoked');
          break;
        case 'expired':
          ws.close(1000, 'expired');
          break;
      }
    }
    session.screen.dispose();

    try {
      session.stdin.end();
    } catch {}
    try {
      session.upstream?.close();
    } catch {}
    untrack(session);
    void this.directory.del(session.id);
  }

  private forward(session: ExecSession, pty: PtyHandle): void {
    pty.output.on('data', (chunk: Buffer) => {
      try {
        session.screen.write(chunk);
      } catch (error) {
        console.warn(`[Terminal] screen write failed: ${(error as Error).message}`);
      }
      const ws = session.browser;
      if (session.state !== 'attached' || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount <= WS_HIGH_WATER) return;
      pty.pause();
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
          pty.resume();
        }
      }, DRAIN_POLL_MS);
    });
  }

  private publish(session: ExecSession): void {
    if (!this.selfAddr) return;
    void this.directory.set(
      session.id,
      directoryEntry(replicaId, this.selfAddr, session.ownerUserId, session.target),
      DETACH_GRACE_MS + 60_000
    );
  }

  private async proxyToOwner(
    client: WebSocket,
    addr: string,
    ctx: ConnectionContext,
    sessionId: string
  ): Promise<boolean> {
    let token: string;
    try {
      token = await signProxyHopToken(this.deps.jwtSecret, {
        sid: sessionId,
        userId: ctx.userId,
        browserSessionId: ctx.browserSessionId,
        sessionOrgScope: ctx.sessionOrgScope,
        tokenAuthCtx: ctx.tokenAuthCtx
      });
    } catch {
      return false;
    }
    const { path, params } = ctx.hooks.proxyPath(ctx.target);
    const target = new URL(`ws://${addr}${path}`);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    target.searchParams.set('session', ctx.requested);
    target.searchParams.set('cols', String(ctx.cols));
    target.searchParams.set('rows', String(ctx.rows));
    if (ctx.proto === 2) target.searchParams.set('proto', '2');

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

const engines = new Set<ExecSessionEngine>();
const engineByServer = new WeakMap<http.Server, ExecSessionEngine>();
const extensionRoutes: ExecRouteHooks[] = [];

export function registerExecRoute(hooks: ExecRouteHooks): void {
  extensionRoutes.push(hooks);
  for (const engine of engines) engine.register(hooks);
}

export function execSessionEngine(
  server: http.Server,
  app: INestApplication,
  opts: { skipUpgrade?: UpgradeSkip } = {}
): ExecSessionEngine {
  let engine = engineByServer.get(server);
  if (!engine) {
    engine = new ExecSessionEngine(server, {
      prisma: app.get(PrismaService),
      sessions: app.get(SessionsService),
      jwtSecret: new TextEncoder().encode(process.env.JWT_SECRET || ''),
      skipUpgrade: opts.skipUpgrade
    });
    engineByServer.set(server, engine);
    engines.add(engine);
    for (const hooks of extensionRoutes) engine.register(hooks);
  } else if (opts.skipUpgrade) {
    engine.setSkipUpgrade(opts.skipUpgrade);
  }
  return engine;
}
