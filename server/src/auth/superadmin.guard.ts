import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from './sessions.service';
import {
  IS_PUBLIC_KEY,
  REQUIRES_AUTH_KEY,
  REQUIRES_SUPERADMIN_KEY,
  REQUIRED_SCOPE_KEY,
  ApiTokenScopeName,
} from './decorators';
import { hashApiToken } from './api-tokens.service';
import { requestAuthStorage } from './request-context';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  private jwtSecret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly reflector: Reflector,
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
      context.getClass(),
    ]);

    if (!requiresAuth) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
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

    // Try JWT first, then fall back to API token
    let authenticated = false;

    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);

      // M-2: reject tokens minted by the MCP OAuth provider. They share the
      // same HS256 signing secret but are issued under a different consent
      // surface — a user authorising an MCP client never agreed to hand that
      // bearer to the first-party API. Sessions issued by oauth.service /
      // passwordless / SSO have no `type` claim and pass through.
      if ((payload as any).type === 'mcp') {
        throw new UnauthorizedException('Invalid token');
      }

      // Resolve the real DB user ID for OAuth users (where sub is a Hack Club ID, not a UUID).
      // Fall back to email if hackClubId lookup fails — without this, a user whose
      // hackClubId column got nulled or overwritten ends up with dbUserId = a Hack Club ID,
      // and every downstream membership query runs against a non-UUID and returns empty
      // (surfacing as a permanent 403 on org-scoped endpoints until they log out).
      let dbUserId = payload.sub as string;
      if (payload.hackClubId) {
        let dbUser = await this.prisma.user.findUnique({
          where: { hackClubId: payload.hackClubId as string },
          select: { id: true },
        });
        if (!dbUser && payload.email) {
          dbUser = await this.prisma.user.findUnique({
            where: { email: payload.email as string },
            select: { id: true },
          });
        }
        if (!dbUser) {
          // Neither hackClubId nor email mapped to a User. Falling through
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

      request['auth'] = { userId: dbUserId };
      request['user'] = {
        sub: dbUserId,
        email: payload.email,
        name: payload.name,
        hackClubId: payload.hackClubId,
        sessionId,
      };
      // Session-auth: no token-scope restrictions to publish to the request context.
      requestAuthStorage.enterWith({});
      authenticated = true;
    } catch {
      // JWT failed — try API token lookup
    }

    if (!authenticated) {
      // Cheap prefix check: bogus bearers (random strings, malformed JWTs) no
      // longer cost a DB round-trip, blunting an unauth'd amplification path.
      if (!token.startsWith('orch_')) {
        throw new UnauthorizedException('Invalid token');
      }

      const apiToken = await this.prisma.apiToken.findUnique({
        where: { tokenHash: hashApiToken(token) },
        include: { user: { select: { id: true, email: true, username: true, firstName: true, lastName: true, hackClubId: true } } },
      });

      if (!apiToken) {
        throw new UnauthorizedException('Invalid token');
      }

      if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
        throw new UnauthorizedException('API token has expired');
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
        tokenProjectIds: restrictedProjectIds,
      };
      request['tokenScopes'] = scopes;
      requestAuthStorage.enterWith({
        apiTokenId: apiToken.id,
        tokenScopes: scopes,
        tokenProjectIds: restrictedProjectIds,
      });
      request['user'] = {
        sub: user.id,
        email: user.email,
        name,
        hackClubId: user.hackClubId,
      };

      // Update lastUsedAt in the background
      this.prisma.apiToken.update({
        where: { id: apiToken.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});
    }

    // Explicit @SuperAdmin() forces the superadmin check even if @Auth() is also present.
    // This makes superadmin-gated controllers self-documenting and resistant to a future
    // maintainer adding @Auth() and accidentally opening the surface.
    const requiresSuperadmin = this.reflector.getAllAndOverride<boolean>(REQUIRES_SUPERADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Check @Auth() — JWT verified, no superadmin check needed (unless @SuperAdmin() overrides)
    if (requiresAuth && !requiresSuperadmin) {
      return true;
    }

    // Default (no decorator) OR explicit @SuperAdmin(): require superadmin
    const userId = request['user'].sub as string;
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) ? [{ id: userId }] : []),
          { hackClubId: userId },
        ],
      },
      select: { id: true, isSuperAdmin: true },
    });

    if (!user || !user.isSuperAdmin) {
      throw new ForbiddenException('Superadmin access required');
    }

    // Store the real DB user ID for downstream use
    request['auth'] = { userId: user.id };

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    const cookieToken = request.cookies?.session_token;

    return authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : cookieToken;
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
      [context.getHandler(), context.getClass()],
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
