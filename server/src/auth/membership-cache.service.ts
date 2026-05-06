import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationRole } from '@prisma/client';

interface CachedEntry {
  memberships: Array<{ organizationId: string; role: OrganizationRole }>;
  expiresAt: number;
}

const TTL_MS = 30_000;

@Injectable()
export class MembershipCacheService {
  private readonly cache = new Map<string, CachedEntry>();
  private readonly inflight = new Map<string, Promise<CachedEntry['memberships']>>();

  constructor(private readonly prisma: PrismaService) {}

  async getMemberships(userId: string): Promise<CachedEntry['memberships']> {
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && hit.expiresAt > now) return hit.memberships;

    const pending = this.inflight.get(userId);
    if (pending) return pending;

    const promise = this.prisma.organizationMember
      .findMany({
        where: { userId },
        select: { organizationId: true, role: true },
      })
      .then((memberships) => {
        this.cache.set(userId, { memberships, expiresAt: Date.now() + TTL_MS });
        this.inflight.delete(userId);
        return memberships;
      })
      .catch((err) => {
        this.inflight.delete(userId);
        throw err;
      });

    this.inflight.set(userId, promise);
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
