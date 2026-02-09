import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  private jwtSecret: Uint8Array;

  constructor(private readonly prisma: PrismaService) {
    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const authHeader = request.headers.authorization;
    const cookieToken = request.cookies?.session_token;

    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : cookieToken;

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);
      request['auth'] = { userId: payload.sub };
      request['user'] = {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        hackClubId: payload.hackClubId,
      };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    // Check superadmin status from database
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
}
