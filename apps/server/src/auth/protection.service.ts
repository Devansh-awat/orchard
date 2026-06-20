import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';

export interface ProtectionDecision {
  allow: boolean;
  status?: number;
  headers?: Record<string, string>;
}

interface CachedIngress {
  id: string;
  projectId: string;
  protectionMode: string;
  protectionPasswordHash: string | null;
  protectionBypassSecret: string | null;
  project: { organizationId: string; name: string };
  host: string;
  expiresAt: number;
}

@Injectable()
export class ProtectionService {
  private readonly jwtSecret: Uint8Array;
  private readonly frontendUrl: string;
  private readonly ingressCache = new Map<string, CachedIngress>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
  ) {
    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
    this.frontendUrl = process.env.FRONTEND_URL || 'https://orchard.my';
  }

  async resolveIngressFromHost(host: string): Promise<CachedIngress | null> {
    const cached = this.ingressCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const ingress = await this.prisma.ingress.findFirst({
      where: { host, protectionMode: { not: 'none' } },
      select: {
        id: true,
        projectId: true,
        protectionMode: true,
        protectionPasswordHash: true,
        protectionBypassSecret: true,
        host: true,
        project: { select: { organizationId: true, name: true } },
      },
    });

    if (!ingress) {
      this.ingressCache.delete(host);
      return null;
    }

    const entry: CachedIngress = {
      ...ingress,
      expiresAt: Date.now() + 5_000,
    };
    this.ingressCache.set(host, entry);
    return entry;
  }

  async checkProtection(
    host: string,
    originalPath: string,
    cookieHeader: string | undefined,
    bypassHeader: string | undefined,
  ): Promise<ProtectionDecision> {
    const ingress = await this.resolveIngressFromHost(host);
    if (!ingress) return { allow: true };

    if (bypassHeader && ingress.protectionBypassSecret) {
      const a = Buffer.from(bypassHeader);
      const b = Buffer.from(ingress.protectionBypassSecret);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { allow: true };
      }
    }

    const tokenMatch = originalPath.match(/[?&]__orchard_token=([^&]+)/);
    if (tokenMatch) {
      const exchangeToken = decodeURIComponent(tokenMatch[1]);
      const payload = await this.verifyProtectionJwt(exchangeToken, 'protection_exchange', ingress.id);
      if (payload) {
        const cookieJwt = await this.generateProtectionCookie(ingress.id, payload.sub as string);
        const cleanPath = originalPath
          .replace(/[?&]__orchard_token=[^&]+/, '')
          .replace(/\?$/, '') || '/';

        return {
          allow: false,
          status: 302,
          headers: {
            location: `https://${host}${cleanPath}`,
            'set-cookie': `_orchard_protection=${cookieJwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
          },
        };
      }
    }

    const protectionCookie = this.extractCookie(cookieHeader, '_orchard_protection');
    if (protectionCookie) {
      const payload = await this.verifyProtectionJwt(protectionCookie, 'protection', ingress.id);
      if (payload) return { allow: true };
    }

    const returnTo = `https://${host}${originalPath}`;
    const params = new URLSearchParams({
      ingressId: ingress.id,
      returnTo,
    });
    if (ingress.protectionMode === 'password') {
      params.set('mode', 'password');
    }

    return {
      allow: false,
      status: 302,
      headers: {
        location: `${this.frontendUrl}/auth/protect?${params.toString()}`,
      },
    };
  }

  async generateExchangeToken(ingressId: string, subject: string): Promise<string> {
    return new SignJWT({ type: 'protection_exchange', ingressId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.jwtSecret);
  }

  async generateProtectionCookie(ingressId: string, subject: string): Promise<string> {
    return new SignJWT({ type: 'protection', ingressId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);
  }

  async verifyProtectionJwt(
    token: string,
    expectedType: string,
    expectedIngressId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);
      if (payload.type !== expectedType) return null;
      if (payload.ingressId !== expectedIngressId) return null;
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async verifyPassword(ingressId: string, password: string): Promise<boolean> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { protectionPasswordHash: true, protectionMode: true },
    });
    if (!ingress || ingress.protectionMode !== 'password' || !ingress.protectionPasswordHash) {
      return false;
    }
    return bcrypt.compare(password, ingress.protectionPasswordHash);
  }

  async checkUserAccess(ingressId: string, userId: string): Promise<boolean> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: {
        projectId: true,
        project: { select: { organizationId: true } },
      },
    });
    if (!ingress) return false;

    const access = await this.authz.resolveProjectAccess(
      ingress.projectId,
      ingress.project.organizationId,
      userId,
    );
    return !!access?.canView;
  }

  async getIngressInfo(ingressId: string): Promise<{
    host: string;
    protectionMode: string;
    projectName: string;
  } | null> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: {
        host: true,
        protectionMode: true,
        project: { select: { name: true } },
      },
    });
    if (!ingress || ingress.protectionMode === 'none') return null;
    return {
      host: ingress.host,
      protectionMode: ingress.protectionMode,
      projectName: ingress.project.name,
    };
  }

  async validateReturnTo(ingressId: string, returnTo: string): Promise<void> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { host: true },
    });
    if (!ingress) throw new NotFoundException('Ingress not found');

    let url: URL;
    try {
      url = new URL(returnTo);
    } catch {
      throw new BadRequestException('Invalid returnTo URL');
    }
    if (url.hostname !== ingress.host) {
      throw new BadRequestException('returnTo does not match ingress host');
    }
  }

  private extractCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1] : null;
  }
}
