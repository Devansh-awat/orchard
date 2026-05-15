import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { randomBytes, createHash } from 'crypto';

// Hard cap on token lifetime. Leaked tokens have no scope (they inherit the
// owning user's full permissions), so an infinite-lifetime token is a
// permanent account compromise. 90d keeps CI/CD rotations practical while
// bounding blast radius.
const MAX_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export type ApiTokenScope = 'read' | 'deploy' | 'exec';
const VALID_SCOPES: ReadonlySet<string> = new Set(['read', 'deploy', 'exec']);

export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private normalizeScopes(input: unknown): ApiTokenScope[] {
    if (!Array.isArray(input) || input.length === 0) return ['read'];
    const cleaned: ApiTokenScope[] = [];
    for (const s of input) {
      if (typeof s !== 'string') {
        throw new BadRequestException('Invalid scope');
      }
      if (!VALID_SCOPES.has(s)) {
        throw new BadRequestException(`Unknown scope: ${s}`);
      }
      if (!cleaned.includes(s as ApiTokenScope)) cleaned.push(s as ApiTokenScope);
    }
    return cleaned;
  }

  async create(userId: string, name: string, expiresAt?: Date, scopes?: unknown) {
    const now = Date.now();
    const cap = new Date(now + MAX_TOKEN_LIFETIME_MS);
    let resolvedExpiresAt: Date;
    if (!expiresAt) {
      resolvedExpiresAt = cap;
    } else {
      if (Number.isNaN(expiresAt.getTime())) {
        throw new BadRequestException('Invalid expiresAt');
      }
      if (expiresAt.getTime() <= now) {
        throw new BadRequestException('expiresAt must be in the future');
      }
      resolvedExpiresAt = expiresAt.getTime() > cap.getTime() ? cap : expiresAt;
    }

    const resolvedScopes = this.normalizeScopes(scopes);
    const token = `orch_${randomBytes(32).toString('hex')}`;
    const tokenHash = hashApiToken(token);

    const apiToken = await this.prisma.apiToken.create({
      data: {
        name,
        tokenHash,
        scopes: resolvedScopes,
        userId,
        expiresAt: resolvedExpiresAt,
      },
    });

    void this.audit.log({
      action: 'api_token.created',
      actorUserId: userId,
      targetType: 'api_token',
      targetId: apiToken.id,
      targetLabel: name,
      metadata: { expiresAt: resolvedExpiresAt.toISOString(), scopes: resolvedScopes },
    });

    // Plaintext is returned once on creation and never persisted.
    return {
      id: apiToken.id,
      name: apiToken.name,
      token,
      scopes: resolvedScopes,
      createdAt: apiToken.createdAt,
      expiresAt: apiToken.expiresAt,
    };
  }

  async list(userId: string) {
    return this.prisma.apiToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(userId: string, tokenId: string) {
    const token = await this.prisma.apiToken.findFirst({
      where: { id: tokenId, userId },
    });

    if (!token) {
      return null;
    }

    await this.prisma.apiToken.delete({ where: { id: tokenId } });

    void this.audit.log({
      action: 'api_token.revoked',
      actorUserId: userId,
      targetType: 'api_token',
      targetId: tokenId,
      targetLabel: token.name,
    });

    return true;
  }

  // Used by sessions.revokeAllSessions to revoke API tokens alongside browser
  // sessions, so "sign out everywhere" actually means everywhere.
  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.prisma.apiToken.deleteMany({ where: { userId } });
    if (res.count > 0) {
      void this.audit.log({
        action: 'api_token.revoked_all',
        actorUserId: userId,
        targetType: 'user',
        targetId: userId,
        metadata: { count: res.count },
      });
    }
    return res.count;
  }
}
