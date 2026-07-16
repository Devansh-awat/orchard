import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface HackClubUserData {
  id: string;
  email: string;
  name: string;
  slackId?: string;
}

// Every authenticated request currently triggers at least two user lookups:
// SuperAdminGuard does one, then the service-layer findOrCreateByClerkId does
// another. The User row barely changes (profile edits are rare), so a tiny
// TTL'd cache keyed by identifier collapses the second hit to memory.
// Short TTL keeps profile updates visible quickly; invalidateUserCache is
// called from updateProfile + admin updateUser to drop stale entries on edits.
const USER_CACHE_TTL_MS = 10_000;
const USER_CACHE_MAX = 5_000;
interface CachedUser { value: any; expiresAt: number }

@Injectable()
export class UsersService {
  private readonly userCache = new Map<string, CachedUser>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private cacheGet(key: string): any | null {
    const hit = this.userCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.userCache.delete(key);
      return null;
    }
    return hit.value;
  }

  private cacheSet(key: string, value: any) {
    if (this.userCache.size >= USER_CACHE_MAX) {
      // Evict oldest entry (Map insertion order). Crude but bounded.
      const firstKey = this.userCache.keys().next().value;
      if (firstKey !== undefined) this.userCache.delete(firstKey);
    }
    this.userCache.set(key, { value, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  }

  invalidateUserCache(user: { id?: string; hackClubId?: string | null; email?: string | null } | null | undefined) {
    if (!user) return;
    if (user.id) this.userCache.delete(user.id);
    if (user.hackClubId) this.userCache.delete(user.hackClubId);
    if (user.email) this.userCache.delete(`email:${user.email.toLowerCase()}`);
  }

  async findOrCreateByHackClubId(hackClubUser: HackClubUserData) {
    let user = await this.prisma.user.findUnique({
      where: { hackClubId: hackClubUser.id }
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: hackClubUser.email }
      });

      if (user) {
        if (user.hackClubId && user.hackClubId !== hackClubUser.id) {
          // Email row is already linked to a different Hack Club identity.
          throw new ConflictException(
            'An account with this email already exists. Sign in with your email first, then link your Hack Club account from settings.',
          );
        }
        const previous = user;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            hackClubId: hackClubUser.id,
            // Hack Club is the identity provider asserting this address, so
            // treat it as verified. Don't clobber an existing verification.
            ...(user.emailVerified
              ? {}
              : { emailVerified: true, emailVerifiedAt: new Date() }),
          },
        });
        this.invalidateUserCache(previous);
        this.invalidateUserCache(user);
      } else {
        const nameParts = hackClubUser.name.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || null;

        const baseUsername = hackClubUser.email.split('@')[0];
        let username = baseUsername;
        let counter = 1;

        while (await this.prisma.user.findUnique({ where: { username } })) {
          username = `${baseUsername}${counter}`;
          counter++;
        }

        user = await this.prisma.user.create({
          data: {
            hackClubId: hackClubUser.id,
            email: hackClubUser.email,
            username,
            firstName,
            lastName,
            // Hack Club OAuth asserts the email; mark it verified so the user
            // can accept org invitations without a separate email flow.
            emailVerified: true,
            emailVerifiedAt: new Date(),
          }
        });
        void this.audit.log({
          action: 'user.signed_up',
          actorUserId: user.id,
          actorEmail: user.email,
          targetType: 'user',
          targetId: user.id,
          metadata: { signup_method: 'hackclub_oauth' },
        });
      }
    } else {
      // Only sync email; do not overwrite firstName/lastName
      // as the user may have manually updated them via profile settings.
      user = await this.prisma.user.update({
        where: { hackClubId: hackClubUser.id },
        data: {
          email: hackClubUser.email,
          // Backfill verification for existing Hack Club OAuth users created
          // before email was auto-verified.
          ...(user.emailVerified
            ? {}
            : { emailVerified: true, emailVerifiedAt: new Date() }),
        }
      });
    }

    return user;
  }

  async findByHackClubId(hackClubId: string) {
    const cached = this.cacheGet(hackClubId);
    if (cached) return cached;
    const user = await this.prisma.user.findUnique({ where: { hackClubId } });
    if (user) {
      this.cacheSet(hackClubId, user);
      this.cacheSet(user.id, user);
    }
    return user;
  }

  async findById(id: string) {
    const cached = this.cacheGet(id);
    if (cached) return cached;
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user) {
      this.cacheSet(id, user);
      if (user.hackClubId) this.cacheSet(user.hackClubId, user);
    }
    return user;
  }

  async ensureImageUrl(user: any): Promise<string | null> {
    return user.imageUrl || null;
  }

  async getUserIdFromHackClubId(hackClubId: string): Promise<string> {
    const user = await this.findByHackClubId(hackClubId);
    if (!user) {
      throw new Error(`User not found for Hack Club ID: ${hackClubId}`);
    }
    return user.id;
  }

  async findByIdOrHackClubId(identifier: string) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(identifier)) {
      return this.findById(identifier);
    } 
      return this.findByHackClubId(identifier);
    
  }

  async findOrCreateByClerkId(identifier: string, userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string }) {
    let user = await this.findByIdOrHackClubId(identifier);

    if (!user && userData?.email) {
      // Try to find by email first
      user = await this.prisma.user.findUnique({
        where: { email: userData.email },
      });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const identifierIsUuid = uuidRegex.test(identifier);

      if (user) {
        // Link the hackClubId to the existing user — but never overwrite it
        // with a UUID. Callers pass `req.user.sub` here, which SuperAdminGuard
        // has already resolved to the DB UUID for OAuth users. Writing that
        // UUID into `hackClubId` clobbers the real Hack Club ID and breaks
        // every future SuperAdminGuard lookup (`findUnique({ hackClubId })`
        // returns null → `dbUserId` falls back to `payload.sub` (a HCID) →
        // membership queries run against a non-UUID userId → 403 "Not a
        // member of this organization" forever, until the user logs out.
        const previous = user;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            ...(identifierIsUuid ? {} : { hackClubId: identifier }),
            ...(userData.firstName && { firstName: userData.firstName }),
            ...(userData.lastName && { lastName: userData.lastName }),
            ...(userData.imageUrl && { imageUrl: userData.imageUrl }),
          },
        });
        this.invalidateUserCache(previous);
        this.invalidateUserCache(user);
      } else {
        // No existing record by id, hackClubId, or email. If the identifier
        // looks like a UUID we cannot legitimately create a Hack Club–linked
        // user from it — bail out so we don't write garbage into hackClubId.
        if (identifierIsUuid) return null;

        // Create a new user with the (presumably-real) Hack Club identifier.
        let username = userData.username || userData.email.split('@')[0];
        let counter = 1;

        while (await this.prisma.user.findUnique({ where: { username } })) {
          username = `${userData.username || userData.email.split('@')[0]}${counter}`;
          counter++;
        }

        user = await this.prisma.user.create({
          data: {
            hackClubId: identifier,
            email: userData.email,
            username,
            firstName: userData.firstName || null,
            lastName: userData.lastName || null,
            imageUrl: userData.imageUrl || null,
          },
        });
        void this.audit.log({
          action: 'user.signed_up',
          actorUserId: user.id,
          actorEmail: user.email,
          targetType: 'user',
          targetId: user.id,
          metadata: { signup_method: 'clerk_id' },
        });
      }
    }

    return user;
  }

  async syncImageUrlFromClerk(_hackClubId: string): Promise<string | null> {
    return null;
  }

  async updateProfile(userId: string, data: { firstName?: string | null; lastName?: string | null; username?: string; setupCompleted?: boolean; imageUrl?: string | null }) {
    // If username is being updated, check format and uniqueness
    if (data.username !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,39}$/.test(data.username)) {
        throw new BadRequestException(
          'Username may only contain letters, numbers, underscores, and hyphens (max 39 characters)',
        );
      }
      const existingUser = await this.prisma.user.findUnique({
        where: { username: data.username }
      });
      if (existingUser && existingUser.id !== userId) {
        throw new Error('Username is already taken');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.username !== undefined && { username: data.username }),
        ...(data.setupCompleted !== undefined && { setupCompleted: data.setupCompleted }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        hackClubId: true,
        setupCompleted: true,
      }
    });
    this.invalidateUserCache(updated);
    return updated;
  }
}

