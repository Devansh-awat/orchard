import * as http from 'http';
import * as WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { jwtVerify } from 'jose';
import { PassThrough } from 'stream';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { hashApiToken } from '../auth/api-tokens.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const sessions = app.get(SessionsService);
  const audit = app.get(AuditService);

  const wss = new WebSocket.Server({ noServer: true });

  const kc = new k8s.KubeConfig();
  const base64Value = process.env.KUBECONFIG_BASE64;
  const configPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;

  if (base64Value) {
    kc.loadFromString(Buffer.from(base64Value, 'base64').toString('utf-8'));
  } else if (configPath) {
    // Try base64 first, then file
    try {
      const decoded = Buffer.from(configPath, 'base64').toString('utf-8');
      if (decoded.includes('apiVersion') || decoded.includes('clusters')) {
        kc.loadFromString(decoded);
      } else {
        kc.loadFromFile(configPath);
      }
    } catch {
      kc.loadFromFile(configPath);
    }
  } else {
    kc.loadFromDefault();
  }

  const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET || '');

  server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/apiv1\/pods\/([^/]+)\/exec$/);
    if (!match) return; // Not our route — let other handlers deal with it

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    // Auth: parse session_token from cookies or Authorization header (for API tokens).
    const cookies = parseCookies(req.headers.cookie || '');
    const authHeader = req.headers['authorization'];
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    const token = cookies['session_token'] || bearer;
    if (!token) return reject(401, 'Unauthorized');

    let userId: string | undefined;
    let actorEmail: string | undefined;
    try {
      const { payload } = await jwtVerify(token, jwtSecret);

      // Require sessionId binding so revocation actually works for exec.
      const sessionId = payload.sessionId as string | undefined;
      if (!sessionId) return reject(401, 'Unauthorized');
      const sessionValid = await sessions.validateSession(sessionId);
      if (!sessionValid) return reject(401, 'Unauthorized');

      // Resolve sub → internal user UUID (sub may be hackClubId for OAuth).
      let dbUserId = payload.sub as string;
      if (payload.hackClubId) {
        const dbUser = await prisma.user.findUnique({
          where: { hackClubId: payload.hackClubId as string },
          select: { id: true, email: true },
        });
        if (dbUser) {
          dbUserId = dbUser.id;
          actorEmail = dbUser.email;
        }
      }
      if (!UUID_RE.test(dbUserId)) {
        const dbUser = await prisma.user.findFirst({
          where: { hackClubId: dbUserId },
          select: { id: true, email: true },
        });
        if (!dbUser) return reject(401, 'Unauthorized');
        dbUserId = dbUser.id;
        actorEmail = dbUser.email;
      }
      if (!actorEmail) {
        const u = await prisma.user.findUnique({ where: { id: dbUserId }, select: { email: true } });
        actorEmail = u?.email;
      }
      userId = dbUserId;
    } catch {
      // JWT failed — try API token. API tokens are also bound to a user; treat them
      // as session-revocation-equivalent only if they have not expired.
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
      if (!scopes.includes('exec')) {
        // API tokens default to read-only. Pod exec is one of the most
        // dangerous capabilities; require it to be explicitly granted at
        // token creation rather than inherited from the owning user's role.
        return reject(403, 'Forbidden');
      }
      userId = apiToken.user.id;
      actorEmail = apiToken.user.email;
      prisma.apiToken.update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    }

    if (!userId) return reject(401, 'Unauthorized');

    const podName = match[1];
    const namespace = url.searchParams.get('namespace') || '';
    const container = url.searchParams.get('container') || '';
    if (!namespace) return reject(400, 'Bad Request');

    // Resolve namespace → project, then require project-edit (blocks viewers + non-members).
    const project = await prisma.project.findFirst({
      where: { namespace },
      select: { id: true, organizationId: true },
    });
    if (!project) return reject(404, 'Not Found');

    try {
      await authz.requireProjectEdit(project.id, userId, 'exec into pod');
    } catch {
      // 404 to non-members so we don't leak project existence.
      return reject(404, 'Not Found');
    }

    // Audit the connection before handing off to the exec session.
    audit.log({
      action: 'deployment.pod.exec',
      actorUserId: userId,
      actorEmail: actorEmail ?? null,
      organizationId: project.organizationId,
      projectId: project.id,
      targetType: 'pod',
      targetId: podName,
      targetLabel: podName,
      metadata: { namespace, container: container || null },
    }).catch(() => {});

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleExecSession(ws, kc, namespace, podName, container);
    });
  });
}

function handleExecSession(
  ws: WebSocket,
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
) {
  const exec = new k8s.Exec(kc);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Forward stdout → ws
  stdout.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Forward stderr → ws
  stderr.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Forward ws messages → stdin
  ws.on('message', (data: WebSocket.Data) => {
    const msg = typeof data === 'string' ? data : data.toString();

    // Handle resize messages: JSON with type "resize"
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize') {
        // k8s exec doesn't support resize on non-tty streams easily,
        // but the resize is handled by the terminal emulator client-side
        return;
      }
    } catch {
      // Not JSON — treat as terminal input
    }

    stdin.write(msg);
  });

  let execClosed = false;

  ws.on('close', () => {
    execClosed = true;
    stdin.end();
  });

  ws.on('error', () => {
    execClosed = true;
    stdin.end();
  });

  // Determine shell: try /bin/bash, fall back to /bin/sh
  const command = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];

  exec.exec(
    namespace,
    podName,
    container,
    command,
    stdout,
    stderr,
    stdin,
    true, // tty
    (status) => {
      if (!execClosed && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, status.status === 'Success' ? 'exited' : `exec failed: ${status.message}`);
      }
    },
  ).catch((err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\nError: ${err.message}\r\n`);
      ws.close(1011, 'exec error');
    }
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}
