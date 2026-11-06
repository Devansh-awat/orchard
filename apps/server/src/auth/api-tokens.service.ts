import {
  ForbiddenException,
  BadRequestException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
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

const MAX_TOKEN_DEPTH = 8;
const LINEAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTokenLineage(token: string): string[] | null {
  const ids = token.split('.').slice(1);
  if (ids.length > MAX_TOKEN_DEPTH) return null;
  return ids.every((id) => LINEAGE_ID_RE.test(id)) ? ids : null;
}

export async function resolveTokenLineage(
  prisma: {
    apiToken: {
      findMany(args: {
        where: { id: { in: string[] } };
        select: { id: true; expiresAt: true };
      }): Promise<{ id: string; expiresAt: Date | null }[]>;
    };
  },
  token: string
): Promise<string[] | null> {
  const ids = parseTokenLineage(token);
  if (!ids) return null;
  if (ids.length === 0) return ids;
  const rows = await prisma.apiToken.findMany({
    where: { id: { in: ids } },
    select: { id: true, expiresAt: true }
  });
  const now = Date.now();
  const alive = new Set(
    rows.filter((row) => !row.expiresAt || row.expiresAt.getTime() > now).map((row) => row.id)
  );
  return ids.every((id) => alive.has(id)) ? ids : null;
}

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService
  ) {}

  // Restrict-list validation: every listed project must be one the creating user
  // can already view, otherwise we'd happily mint tokens for unreachable projects.
  // Returns the deduplicated, normalised list.
  private async normalizeRestrictedProjects(userId: string, input: unknown): Promise<string[]> {
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
        "restrictedProjectIds can't be an empty array; omit the field for an unrestricted token"
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
    ceiling?: { scopes: string[]; projectIds: string[]; tokenId: string; lineage: string[] },
    scopeOrganizationId?: string
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

    let lineage: string[] = [];
    if (ceiling) {
      if (ceiling.lineage.length + 1 > MAX_TOKEN_DEPTH) {
        throw new ForbiddenException('This token is too many mints deep to mint another');
      }
      const parent = await this.prisma.apiToken.findUnique({
        where: { id: ceiling.tokenId },
        select: { expiresAt: true }
      });
      if (!parent || (parent.expiresAt && parent.expiresAt.getTime() <= now)) {
        throw new ForbiddenException('This token is no longer valid');
      }
      if (parent.expiresAt && parent.expiresAt.getTime() < resolvedExpiresAt.getTime()) {
        resolvedExpiresAt = parent.expiresAt;
      }
      lineage = [...ceiling.lineage, ceiling.tokenId];
    }

    const resolvedScopes = this.normalizeScopes(scopes);
    const resolvedRestrictedProjects = await this.normalizeRestrictedProjects(
      userId,
      restrictedProjectIds
    );
    if (ceiling) {
      const rank = (s: string) => ['read', 'deploy', 'exec'].indexOf(s);
      const ceilingRank = Math.max(-1, ...ceiling.scopes.map(rank));
      if (resolvedScopes.some((s) => rank(s) > ceilingRank)) {
        throw new ForbiddenException("A token can't mint a token with broader scopes than its own");
      }
      if (ceiling.projectIds.length > 0) {
        const allowed = new Set(ceiling.projectIds);
        if (
          resolvedRestrictedProjects.length === 0 ||
          resolvedRestrictedProjects.some((id) => !allowed.has(id))
        ) {
          throw new ForbiddenException(
            "A project-restricted token can't mint a token for other projects"
          );
        }
      }
    }
    const token = `orch_${randomBytes(32).toString('hex')}${lineage.map((id) => `.${id}`).join('')}`;
    const tokenHash = hashApiToken(token);

    const apiToken = await this.prisma.apiToken.create({
      data: {
        name,
        tokenHash,
        scopes: resolvedScopes,
        restrictedProjectIds: resolvedRestrictedProjects,
        scopeOrganizationId,
        userId,
        expiresAt: resolvedExpiresAt
      }
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
        restrictedProjectIds: resolvedRestrictedProjects
      }
    });

    return {
      id: apiToken.id,
      name: apiToken.name,
      token,
      scopes: resolvedScopes,
      restrictedProjectIds: resolvedRestrictedProjects,
      createdAt: apiToken.createdAt,
      expiresAt: apiToken.expiresAt
    };
  }

  async list(userId: string, scopeOrganizationId?: string) {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId, ...(scopeOrganizationId ? { scopeOrganizationId } : {}) },
      select: {
        id: true,
        name: true,
        scopes: true,
        restrictedProjectIds: true,
        scopeOrganizationId: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
    const orgIds = [...new Set(tokens.flatMap((t) => t.scopeOrganizationId ?? []))];
    const orgs = orgIds.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true }
        })
      : [];
    const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
    return tokens.map(({ scopeOrganizationId: orgId, ...token }) => ({
      ...token,
      scopeOrganizationName: orgId ? (orgNames.get(orgId) ?? null) : null
    }));
  }

  async revoke(userId: string, tokenId: string, scopeOrganizationId?: string) {
    const token = await this.prisma.apiToken.findFirst({
      where: { id: tokenId, userId, ...(scopeOrganizationId ? { scopeOrganizationId } : {}) }
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
      targetLabel: token.name
    });

    return true;
  }

  async rename(userId: string, tokenId: string, name: string, scopeOrganizationId?: string) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    const token = await this.prisma.apiToken.findFirst({
      where: { id: tokenId, userId, ...(scopeOrganizationId ? { scopeOrganizationId } : {}) }
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
        createdAt: true
      }
    });

    void this.audit.log({
      action: 'api_token.renamed',
      actorUserId: userId,
      targetType: 'api_token',
      targetId: tokenId,
      targetLabel: trimmed,
      metadata: { name: [token.name, trimmed] }
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
        metadata: { count: res.count }
      });
    }
    return res.count;
  }
}
