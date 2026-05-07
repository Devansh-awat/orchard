import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationRole } from '@prisma/client';

interface CachedEntry {
  memberships: Array<{ organizationId: string; role: OrganizationRole }>;
  expiresAt: number;
}

const TTL_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class MembershipCacheService {
  private readonly cache = new Map<string, CachedEntry>();
  private readonly inflight = new Map<string, Promise<CachedEntry['memberships']>>();
  // sub (JWT subject) → internal UUID. JWT sub may be a Hack Club ID;
  // organizationMember.userId is a UUID FK so we have to resolve first.
  private readonly subToInternal = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  private async resolveInternalId(sub: string): Promise<string | null> {
    if (UUID_RE.test(sub)) return sub;
    const cached = this.subToInternal.get(sub);
    if (cached) return cached;
    const user = await this.prisma.user.findFirst({
      where: { hackClubId: sub },
      select: { id: true },
    });
    if (!user) return null;
    this.subToInternal.set(sub, user.id);
    return user.id;
  }

  async getMemberships(sub: string): Promise<CachedEntry['memberships']> {
    const now = Date.now();
    const hit = this.cache.get(sub);
    if (hit && hit.expiresAt > now) return hit.memberships;

    const pending = this.inflight.get(sub);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const internalId = await this.resolveInternalId(sub);
        if (!internalId) {
          this.cache.set(sub, { memberships: [], expiresAt: Date.now() + TTL_MS });
          return [];
        }
        const memberships = await this.prisma.organizationMember.findMany({
          where: { userId: internalId },
          select: { organizationId: true, role: true },
        });
        this.cache.set(sub, { memberships, expiresAt: Date.now() + TTL_MS });
        return memberships;
      } finally {
        this.inflight.delete(sub);
      }
    })();

    this.inflight.set(sub, promise);
    return promise;
  }

  async getMembershipsForOrg(userId: string, orgId: string) {
    const all = await this.getMemberships(userId);
    return all.filter((m) => m.organizationId === orgId);
  }

  invalidateUser(userId: string) {
    this.cache.delete(userId);
  }

  invalidateOrg(organizationId: string) {
    for (const [userId, entry] of this.cache) {
      if (entry.memberships.some((m) => m.organizationId === organizationId)) {
        this.cache.delete(userId);
      }
    }
  }

  invalidateAll() {
    this.cache.clear();
  }
}
