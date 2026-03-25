import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY, REQUIRES_AUTH_KEY } from './decorators';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  private jwtSecret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
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

      // Resolve the real DB user ID for OAuth users (where sub is a Hack Club ID, not a UUID)
      let dbUserId = payload.sub as string;
      if (payload.hackClubId) {
        const dbUser = await this.prisma.user.findUnique({
          where: { hackClubId: payload.hackClubId as string },
          select: { id: true },
        });
        if (dbUser) {
          dbUserId = dbUser.id;
        }
      }

      request['auth'] = { userId: dbUserId };
      request['user'] = {
        sub: dbUserId,
        email: payload.email,
        name: payload.name,
        hackClubId: payload.hackClubId,
      };
      authenticated = true;
    } catch {
      // JWT failed — try API token lookup
    }

    if (!authenticated) {
      const apiToken = await this.prisma.apiToken.findUnique({
        where: { token },
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

      request['auth'] = { userId: user.id };
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

    // Check @Auth() — JWT verified, no superadmin check needed
    if (requiresAuth) {
      return true;
    }

    // Default: require superadmin
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
