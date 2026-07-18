import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from './authorization.service';

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
    private readonly authz: AuthorizationService,
  ) {}

  // Restrict-list validation: every listed project must be one the creating user
  // can already view, otherwise we'd happily mint tokens for unreachable projects.
  // Returns the deduplicated, normalised list.
  private async normalizeRestrictedProjects(
    userId: string,
    input: unknown,
  ): Promise<string[]> {
    if (input == null) return [];
    if (!Array.isArray(input)) {
      throw new BadRequestException('restrictedProjectIds must be an array');
    }
    // Reject an explicit empty array. Downstream consumers treat [] as "no
    // restriction" (unrestricted token), so silently accepting [] from a
    // caller who meant "scoped to nothing" would mint a fully-privileged
    // token. Force the caller to omit the field if they want unrestricted.
    if (input.length === 0) {
      throw new BadRequestException(
        'restrictedProjectIds cannot be an empty array; omit the field for an unrestricted token',
      );
    }
    const seen = new Set<string>();
    for (const v of input) {
      if (typeof v !== 'string' || !v) {
        throw new BadRequestException('restrictedProjectIds entries must be strings');
      }
      seen.add(v);
    }
    for (const projectId of seen) {
      try {
        await this.authz.requireProjectView(projectId, userId);
      } catch {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
    }
    return Array.from(seen);
  }

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

  async create(
    userId: string,
    name: string,
    expiresAt?: Date,
    scopes?: unknown,
    restrictedProjectIds?: unknown,
  ) {
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
    const resolvedRestrictedProjects = await this.normalizeRestrictedProjects(userId, restrictedProjectIds);
    const token = `orch_${randomBytes(32).toString('hex')}`;
    const tokenHash = hashApiToken(token);

    const apiToken = await this.prisma.apiToken.create({
      data: {
        name,
        tokenHash,
        scopes: resolvedScopes,
        restrictedProjectIds: resolvedRestrictedProjects,
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
      metadata: {
        expiresAt: resolvedExpiresAt.toISOString(),
        scopes: resolvedScopes,
        restrictedProjectIds: resolvedRestrictedProjects,
      },
    });

    return {
      id: apiToken.id,
      name: apiToken.name,
      token,
      scopes: resolvedScopes,
      restrictedProjectIds: resolvedRestrictedProjects,
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
        restrictedProjectIds: true,
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

  async rename(userId: string, tokenId: string, name: string) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    const token = await this.prisma.apiToken.findFirst({
      where: { id: tokenId, userId },
    });

    if (!token) {
      return null;
    }

    const updated = await this.prisma.apiToken.update({
      where: { id: tokenId },
      data: { name: trimmed },
      select: {
        id: true,
        name: true,
        scopes: true,
        restrictedProjectIds: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    void this.audit.log({
      action: 'api_token.renamed',
      actorUserId: userId,
      targetType: 'api_token',
      targetId: tokenId,
      targetLabel: trimmed,
      metadata: { name: [token.name, trimmed] },
    });

    return updated;
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
