import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { randomBytes } from 'crypto';

// Hard cap on token lifetime. Leaked tokens have no scope (they inherit the
// owning user's full permissions), so an infinite-lifetime token is a
// permanent account compromise. 90d keeps CI/CD rotations practical while
// bounding blast radius.
const MAX_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, name: string, expiresAt?: Date) {
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

    const token = `orch_${randomBytes(32).toString('hex')}`;

    const apiToken = await this.prisma.apiToken.create({
      data: {
        name,
        token,
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
      metadata: { expiresAt: resolvedExpiresAt.toISOString() },
    });

    // Return the raw token only on creation
    return { id: apiToken.id, name: apiToken.name, token, createdAt: apiToken.createdAt, expiresAt: apiToken.expiresAt };
  }

  async list(userId: string) {
    return this.prisma.apiToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
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
}
