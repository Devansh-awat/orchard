import type * as http from 'http';
import { jwtVerify } from 'jose';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from './sessions.service';
import { hashApiToken } from './api-tokens.service';
import { assertBrowserSession } from './session-jwt';
import { readSessionCookie } from './cookies';

export interface UpgradeIdentity {
  userId: string;
  email: string | null;
  sessionId: string | null;
  orgScope: string | null;
  via: 'cookie' | 'bearer' | 'api-token';
}

export function platformOrigins(): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      origins.add(new URL(value.trim()).origin);
    } catch {}
  };
  add(process.env.FRONTEND_URL || 'http://localhost:5173');
  for (const entry of (process.env.PLATFORM_ORIGINS || '').split(',')) add(entry);
  return origins;
}

export function originAllowed(
  origin: string | string[] | undefined,
  allowed: Set<string>,
  via: UpgradeIdentity['via'] | null
): boolean {
  if (Array.isArray(origin)) return false;
  if (origin === undefined || origin === '') return via !== null && via !== 'cookie';
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of (header || '').split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    if (key && !(key in cookies)) cookies[key] = pair.slice(at + 1).trim();
  }
  return cookies;
}

export interface UpgradeAuthDeps {
  prisma: Pick<PrismaService, 'user' | 'apiToken'>;
  sessions: Pick<SessionsService, 'validateSession'>;
  jwtSecret: string;
  requiredScope: string;
}

export async function authenticateUpgrade(
  req: http.IncomingMessage,
  deps: UpgradeAuthDeps
): Promise<UpgradeIdentity | null> {
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
  const cookieToken = readSessionCookie(cookies);
  const token = cookieToken || bearer;
  if (!token) return null;
  const via: UpgradeIdentity['via'] = cookieToken ? 'cookie' : 'bearer';
  if (!token.startsWith('orch_')) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(deps.jwtSecret));
      const sessionId = assertBrowserSession(payload);
      if (!(await deps.sessions.validateSession(sessionId))) return null;
      const externalAuthId = (payload.externalAuthId ?? payload.hackClubId ?? payload.sub) as
        | string
        | undefined;
      const user = await deps.prisma.user.findFirst({
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
      if (!user) return null;
      const orgScope = typeof payload.orgScope === 'string' ? payload.orgScope : null;
      return { userId: user.id, email: user.email ?? null, sessionId, orgScope, via };
    } catch {
      return null;
    }
  }
  const apiToken = await deps.prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    include: { user: { select: { id: true, email: true, disabledAt: true } } }
  });
  if (!apiToken) return null;
  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) return null;
  if (apiToken.user.disabledAt) return null;
  const scopes = Array.isArray(apiToken.scopes) ? (apiToken.scopes as string[]) : [];
  if (!scopes.includes(deps.requiredScope)) return null;
  const restricted = Array.isArray(apiToken.restrictedProjectIds)
    ? (apiToken.restrictedProjectIds as string[])
    : [];
  if (restricted.length > 0) return null;
  deps.prisma.apiToken
    .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return {
    userId: apiToken.user.id,
    email: apiToken.user.email ?? null,
    sessionId: null,
    orgScope: apiToken.scopeOrganizationId ?? null,
    via: 'api-token'
  };
}

export function rejectUpgrade(
  socket: { write(data: string): unknown; destroy(): void },
  code: number,
  message: string
) {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}
