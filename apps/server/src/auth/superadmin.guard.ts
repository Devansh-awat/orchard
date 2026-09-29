import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from './sessions.service';
import {
  IS_PUBLIC_KEY,
  REQUIRES_AUTH_KEY,
  REQUIRES_SUPERADMIN_KEY,
  REQUIRED_SCOPE_KEY,
  ApiTokenScopeName
} from './decorators';
import { hashApiToken } from './api-tokens.service';
import { requestAuthStorage, RequestAuthContext } from './request-context';

/**
 * Namespaces an organization-scoped session may never touch.
 *
 * A session minted by one org's identity provider is confined to that org
 * (see RequestAuthContext.sessionOrgId), and the confinement is only worth
 * anything if the session cannot trade itself in for an unconfined one. Each
 * of these is a way to do exactly that: mint an API token, enrol a passkey,
 * move the account's email, adopt an SSH key, or accept an invitation into
 * some other tenant. The org tree itself is gated in AuthorizationService.
 *
 * Read-only self-identity stays reachable so the app can render.
 */
const ORG_SCOPED_DENY = [
  'auth/',
  'ssh-identities',
  'invitations',
  'users/',
  'setup',
  'admin/',
  'github/link',
  'github/unlink',
  'git/oauth/',
  'tailscale/link',
  'tailscale/unlink',
  'sandboxes/credentials'
];
// Method-qualified: reading your own identity is fine, editing it is not.
const ORG_SCOPED_ALLOW = ['GET auth/me', 'POST auth/logout'];

const API_TOKEN_DENY = [
  'auth/passkey/register',
  'auth/password/set',
  'auth/mcp-token',
  'setup',
  'admin'
];

const PLATFORM_ORIGINS = new Set<string>(
  [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    ...(process.env.PLATFORM_ORIGINS || '').split(',')
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return s;
      }
    })
);

function crossSiteMutation(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return !PLATFORM_ORIGINS.has(origin);
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  return false;
}

function deniedToApiToken(path: string): boolean {
  const p = path
    .toLowerCase()
    .replace(/^\/?(apiv1\/)?/, '')
    .replace(/\/+$/, '');
  return API_TOKEN_DENY.some((d) => p === d || p.startsWith(`${d}/`));
}

function deniedToOrgScopedSession(method: string, path: string): boolean {
  const p = path
    .toLowerCase()
    .replace(/^\/?(apiv1\/)?/, '')
    .replace(/\/+$/, '');
  if (ORG_SCOPED_ALLOW.includes(`${method.toUpperCase()} ${p}`)) return false;
  return ORG_SCOPED_DENY.some((d) => p === d.replace(/\/$/, '') || p.startsWith(d));
}

/**
 * Publish the request's auth restrictions.
 *
 * The context object is created by a middleware in main.ts and mutated here,
 * rather than installed with enterWith(): a guard's enterWith() frequently
 * does not survive into the handler, which would silently drop every
 * restriction below.
 */
function publishAuthContext(ctx: RequestAuthContext) {
  const store = requestAuthStorage.getStore();
  if (store) {
    Object.assign(store, ctx);
    return;
  }
  requestAuthStorage.enterWith(ctx);
}

@Injectable()
export class SuperAdminGuard implements CanActivate {
  private jwtSecret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly reflector: Reflector
  ) {
    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlerIsPublic = this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler());
    if (handlerIsPublic) {
      return true;
    }

    const requiresAuth = this.reflector.getAllAndOverride<boolean>(REQUIRES_AUTH_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!requiresAuth) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass()
      ]);
      if (isPublic) {
        return true;
      }
    }

    // Extract and verify JWT token
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    // MCP gateway path: the MCP server authenticates as the service and passes
    // the consenting user's identity in X-Acting-User-* headers. The user's
    // session is still validated for revocation. This is the only legitimate
    // way for an MCP-originated request to reach the first-party API; M-2
    // still rejects type='mcp' JWTs presented directly below.
    const serviceToken = process.env.MCP_SERVICE_TOKEN;
    if (serviceToken && this.constantTimeEquals(token, serviceToken)) {
      const actingSub = request.headers['x-acting-user-sub'] as string | undefined;
      const actingSessionId = request.headers['x-acting-user-session-id'] as string | undefined;
      const actingEmail = request.headers['x-acting-user-email'] as string | undefined;
      const actingExternalAuthId = request.headers['x-acting-user-hackclub-id'] as
        | string
        | undefined;

      if (!actingSub || !actingSessionId) {
        throw new UnauthorizedException('MCP gateway request missing acting-user headers');
      }

      const sessionValid = await this.sessionsService.validateSession(actingSessionId);
      if (!sessionValid) {
        throw new UnauthorizedException('Session has been revoked');
      }
      this.sessionsService.touchSession(actingSessionId).catch(() => {});

      // Resolve to DB user id the same way the JWT path does, so superadmin
      // checks and downstream queries work identically whether the request
      // came in directly or via the MCP gateway.
      let dbUserId = actingSub;
      if (actingExternalAuthId) {
        let dbUser = await this.prisma.user.findUnique({
          where: { externalAuthId: actingExternalAuthId },
          select: { id: true }
        });
        if (!dbUser && actingEmail) {
          dbUser = await this.prisma.user.findUnique({
            where: { email: actingEmail },
            select: { id: true }
          });
        }
        if (!dbUser) {
          throw new UnauthorizedException('User not found for this session');
        }
        dbUserId = dbUser.id;
      }

      request['auth'] = { userId: dbUserId, viaMcpGateway: true };
      request['user'] = {
        sub: dbUserId,
        email: actingEmail,
        externalAuthId: actingExternalAuthId,
        sessionId: actingSessionId,
        viaMcpGateway: true
      };
      publishAuthContext({});

      const requiresSuperadminGw = this.reflector.getAllAndOverride<boolean>(
        REQUIRES_SUPERADMIN_KEY,
        [context.getHandler(), context.getClass()]
      );
      if (requiresAuth && !requiresSuperadminGw) {
        return true;
      }
      const sa = await this.prisma.user.findFirst({
        where: { id: dbUserId },
        select: { isSuperAdmin: true }
      });
      if (!sa || !sa.isSuperAdmin) {
        throw new ForbiddenException('Superadmin access required');
      }
      return true;
    }

    // Try JWT first, then fall back to API token
    let authenticated = false;
    let orgScopeDenied = false;

    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);

      // M-2: reject tokens minted by the MCP OAuth provider. They share the
      // same HS256 signing secret but are issued under a different consent
      // surface — a user authorising an MCP client never agreed to hand that
      // bearer to the first-party API. Sessions issued by oauth.service /
      // passwordless / SSO have no `type` claim and pass through.
      if ((payload as any).type !== undefined) {
        throw new UnauthorizedException('Invalid token');
      }
      if (!request.headers.authorization && crossSiteMutation(request)) {
        throw new ForbiddenException('Cross-site requests cannot use the session cookie');
      }

      // Resolve the real DB user ID for OAuth users (where sub is a Hack Club ID, not a UUID).
      // Fall back to email if externalAuthId lookup fails — without this, a user whose
      // externalAuthId column got nulled or overwritten ends up with dbUserId = a Hack Club ID,
      // and every downstream membership query runs against a non-UUID and returns empty
      // (surfacing as a permanent 403 on org-scoped endpoints until they log out).
      let dbUserId = payload.sub as string;
      const externalAuthId = (payload.externalAuthId ?? payload.hackClubId) as string | undefined;
      if (externalAuthId) {
        let dbUser = await this.prisma.user.findUnique({
          where: { externalAuthId },
          select: { id: true }
        });
        if (!dbUser && payload.email) {
          dbUser = await this.prisma.user.findUnique({
            where: { email: payload.email as string },
            select: { id: true }
          });
        }
        if (!dbUser) {
          // Neither externalAuthId nor email mapped to a User. Falling through
          // would leave dbUserId set to the raw Hack Club ID — a non-UUID —
          // and every downstream Prisma query keyed on it would silently
          // return empty, surfacing as confusing permanent 403/404s. Refuse
          // the request instead.
          throw new UnauthorizedException('User not found for this session');
        }
        dbUserId = dbUser.id;
      }

      // Require a sessionId so that revocation actually kills the token.
      // Pre-fix, JWTs without sessionId survived "Sign out everywhere" for the
      // full 7-day expiry. Every issuance path now mints with a session id;
      // any token lacking one is either pre-fix legacy or a forgery — reject.
      const sessionId = payload.sessionId as string | undefined;
      if (!sessionId) {
        throw new UnauthorizedException('Session has been revoked');
      }
      const sessionValid = await this.sessionsService.validateSession(sessionId);
      if (!sessionValid) {
        throw new UnauthorizedException('Session has been revoked');
      }
      // Touch session in background
      this.sessionsService.touchSession(sessionId).catch(() => {});

      // Sessions minted by an organization's own IdP carry that org, and are
      // confined to it for the rest of the request.
      const orgScope = payload.orgScope as string | undefined;
      if (orgScope && deniedToOrgScopedSession(request.method, request.path)) {
        // Recorded rather than thrown: this block's catch falls through to the
        // API-token path, which would turn the refusal into a generic 401.
        orgScopeDenied = true;
      }

      request['auth'] = { userId: dbUserId, sessionOrgId: orgScope, sessionId };
      request['user'] = {
        sub: dbUserId,
        email: payload.email,
        name: payload.name,
        externalAuthId,
        sessionId,
        orgScope
      };
      // Session-auth: no token-scope restrictions to publish, but an org-scoped
      // session publishes its confinement so AuthorizationService can enforce it.
      publishAuthContext(orgScope ? { sessionOrgId: orgScope } : {});
      authenticated = true;
    } catch {
      // JWT failed — try API token lookup
    }

    if (orgScopeDenied) {
      throw new ForbiddenException(
        'This sign-in is scoped to a single organization and cannot manage account credentials'
      );
    }

    if (!authenticated) {
      // Cheap prefix check: bogus bearers (random strings, malformed JWTs) no
      // longer cost a DB round-trip, blunting an unauth'd amplification path.
      if (!token.startsWith('orch_')) {
        throw new UnauthorizedException('Invalid token');
      }

      const apiToken = await this.prisma.apiToken.findUnique({
        where: { tokenHash: hashApiToken(token) },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              externalAuthId: true
            }
          }
        }
      });

      if (!apiToken) {
        throw new UnauthorizedException('Invalid token');
      }

      if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
        throw new UnauthorizedException('API token has expired');
      }

      if (deniedToApiToken(request.path)) {
        throw new ForbiddenException('An API token cannot enrol credentials; sign in instead');
      }

      const user = apiToken.user;
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;

      const scopes = Array.isArray(apiToken.scopes) ? (apiToken.scopes as string[]) : [];
      const restrictedProjectIds = Array.isArray(apiToken.restrictedProjectIds)
        ? (apiToken.restrictedProjectIds as string[])
        : [];
      request['auth'] = {
        userId: user.id,
        apiTokenId: apiToken.id,
        tokenScopes: scopes,
        tokenProjectIds: restrictedProjectIds
      };
      request['tokenScopes'] = scopes;
      publishAuthContext({
        apiTokenId: apiToken.id,
        tokenScopes: scopes,
        tokenProjectIds: restrictedProjectIds
      });
      request['user'] = {
        sub: user.id,
        email: user.email,
        name,
        externalAuthId: user.externalAuthId
      };

      // Update lastUsedAt in the background
      this.prisma.apiToken
        .update({
          where: { id: apiToken.id },
          data: { lastUsedAt: new Date() }
        })
        .catch(() => {});
    }

    // Explicit @SuperAdmin() forces the superadmin check even if @Auth() is also present.
    // This makes superadmin-gated controllers self-documenting and resistant to a future
    // maintainer adding @Auth() and accidentally opening the surface.
    const requiresSuperadmin = this.reflector.getAllAndOverride<boolean>(REQUIRES_SUPERADMIN_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    // Check @Auth() — JWT verified, no superadmin check needed (unless @SuperAdmin() overrides)
    if (requiresAuth && !requiresSuperadmin) {
      return true;
    }

    // Default (no decorator) OR explicit @SuperAdmin(): require superadmin.
    // An org-scoped session never qualifies, whatever the underlying account
    // is — otherwise one tenant's IdP could reach the platform console.
    if (request['user']?.orgScope) {
      throw new ForbiddenException('Superadmin access required');
    }
    const userId = request['user'].sub as string;
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(userId.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          )
            ? [{ id: userId }]
            : []),
          { externalAuthId: userId }
        ]
      },
      select: { id: true, isSuperAdmin: true }
    });

    if (!user || !user.isSuperAdmin) {
      throw new ForbiddenException('Superadmin access required');
    }

    // Store the real DB user ID for downstream use
    request['auth'] = { ...request['auth'], userId: user.id };

    return true;
  }

  private constantTimeEquals(a: string, b: string): boolean {
    // Length differs → can't be equal; comparing buffers of different lengths
    // would throw. Returning false here leaks length, which is acceptable
    // because the service token length is fixed by deployment.
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    const cookieToken = request.cookies?.session_token;

    return authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : cookieToken;
  }
}

// Enforces API-token scope on every mutating request.
//
// SuperAdminGuard authenticates the principal and (for API tokens) stashes
// the granted scopes on the request. ScopeGuard runs immediately after and
// answers a simpler question: "is this token allowed to do *this kind* of
// thing?"
//
// Defaults are deliberately strict so a new mutating controller can't ship
// without a scope check by accident:
//   - GET / HEAD / OPTIONS → require `read` (or any higher scope)
//   - everything else      → require `deploy` (or `exec`)
// A route may opt into a different requirement with @RequireScope('exec').
// Session-authenticated requests bypass this guard entirely — scopes only
// constrain programmatic token use.
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request['auth'] as { apiTokenId?: string; tokenScopes?: string[] } | undefined;

    // Session auth (no apiTokenId on the auth context) → scopes don't apply.
    if (!auth || !auth.apiTokenId) {
      return true;
    }

    // Public routes (e.g. webhook trigger) never get an apiTokenId set, so
    // they short-circuit above. We don't need an IS_PUBLIC check here.

    const explicit = this.reflector.getAllAndOverride<ApiTokenScopeName | undefined>(
      REQUIRED_SCOPE_KEY,
      [context.getHandler(), context.getClass()]
    );

    const method = (request.method || 'GET').toUpperCase();
    const isReadOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const required: ApiTokenScopeName = explicit ?? (isReadOnly ? 'read' : 'deploy');

    const granted = Array.isArray(auth.tokenScopes) ? auth.tokenScopes : [];

    if (this.scopeSatisfies(granted, required)) {
      return true;
    }

    throw new ForbiddenException(`Token lacks required scope: ${required}`);
  }

  // `exec` ⊇ `deploy` ⊇ `read`. A token granted a higher capability implicitly
  // satisfies the lower ones, which matches how operators reason about these
  // scopes in practice (an exec-capable CI key can also read and deploy).
  private scopeSatisfies(granted: string[], required: ApiTokenScopeName): boolean {
    if (granted.includes(required)) return true;
    if (required === 'read') {
      return granted.includes('deploy') || granted.includes('exec');
    }
    if (required === 'deploy') {
      return granted.includes('exec');
    }
    return false;
  }
}
