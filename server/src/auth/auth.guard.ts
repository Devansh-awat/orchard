import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  private jwtSecret: Uint8Array;

  constructor() {
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
      return true;
    } catch (error) {
      console.error('Authentication error:', error);
      throw new UnauthorizedException('Invalid token');
    }
  }
}

