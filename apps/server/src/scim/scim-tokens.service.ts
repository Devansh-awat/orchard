import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function hashScimToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

@Injectable()
export class ScimTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async create(organizationId: string, actorUserId: string, name: string, expiresAt?: Date) {
    const cleanName = (name ?? '').trim();
    if (!cleanName) {
      throw new BadRequestException('name is required');
    }

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

    const token = `scim_${randomBytes(32).toString('hex')}`;
    const tokenHash = hashScimToken(token);

    const row = await this.prisma.scimToken.create({
      data: {
        organizationId,
        name: cleanName,
        tokenHash,
        createdBy: actorUserId,
        expiresAt: resolvedExpiresAt
      }
    });

    void this.audit.log({
      action: 'scim_token.created',
      actorUserId,
      organizationId,
      targetType: 'scim_token',
      targetId: row.id,
      targetLabel: cleanName,
      metadata: { expiresAt: resolvedExpiresAt.toISOString() }
    });

    return {
      id: row.id,
      name: row.name,
      token,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt
    };
  }

  async list(organizationId: string) {
    return this.prisma.scimToken.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async revoke(organizationId: string, actorUserId: string, tokenId: string) {
    const token = await this.prisma.scimToken.findFirst({
      where: { id: tokenId, organizationId }
    });
    if (!token) {
      return null;
    }

    await this.prisma.scimToken.delete({ where: { id: tokenId } });

    void this.audit.log({
      action: 'scim_token.revoked',
      actorUserId,
      organizationId,
      targetType: 'scim_token',
      targetId: tokenId,
      targetLabel: token.name
    });

    return true;
  }

  // Resolves a presented bearer token to its owning org, or null when the token
  // is unknown, revoked, or expired. Updates lastUsedAt on a hit (best-effort).
  async resolveOrganization(plaintext: string): Promise<string | null> {
    if (!plaintext || !plaintext.startsWith('scim_')) {
      return null;
    }
    const tokenHash = hashScimToken(plaintext);
    const row = await this.prisma.scimToken.findUnique({
      where: { tokenHash },
      select: { id: true, organizationId: true, expiresAt: true }
    });
    if (!row) {
      return null;
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    void this.prisma.scimToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return row.organizationId;
  }
}
