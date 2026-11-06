import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailAvatarService } from './email-avatar.service';
import { discardUnverifiedCredentials } from '../auth/unverified-adoption';

const MAX_SEEN_UPDATES = 100;

export interface HackClubUserData {
  id: string;
  email: string;
  name: string;
  slackId?: string;
}

// Auto-generated usernames must satisfy the same format rule updateProfile
// enforces; email local-parts routinely contain dots and plus-tags, which
// would strand users on a username they could never have chosen themselves.
export function sanitizeUsername(raw: string): string {
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return cleaned || 'user';
}

// Every authenticated request currently triggers at least two user lookups:
// SuperAdminGuard does one, then the service-layer findOrCreateByClerkId does
// another. The User row barely changes (profile edits are rare), so a tiny
// TTL'd cache keyed by identifier collapses the second hit to memory.
// Short TTL keeps profile updates visible quickly; invalidateUserCache is
// called from updateProfile + admin updateUser to drop stale entries on edits.
const USER_CACHE_TTL_MS = 10_000;
const USER_CACHE_MAX = 5_000;
interface CachedUser {
  value: any;
  expiresAt: number;
}

@Injectable()
export class UsersService {
  private readonly userCache = new Map<string, CachedUser>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emailAvatar: EmailAvatarService
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

  invalidateUserCache(
    user: { id?: string; externalAuthId?: string | null; email?: string | null } | null | undefined
  ) {
    if (!user) return;
    if (user.id) this.userCache.delete(user.id);
    if (user.externalAuthId) this.userCache.delete(user.externalAuthId);
    if (user.email) this.userCache.delete(`email:${user.email.toLowerCase()}`);
  }

  async findOrCreateByExternalAuthId(hackClubUser: HackClubUserData) {
    let user = await this.prisma.user.findUnique({
      where: { externalAuthId: hackClubUser.id }
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: hackClubUser.email }
      });

      if (user) {
        if (user.externalAuthId && user.externalAuthId !== hackClubUser.id) {
          // Email row is already linked to a different Hack Club identity.
          throw new ConflictException(
            'An account with this email already exists. Sign in with your email first, then link your Hack Club account from settings.'
          );
        }
        const previous = user;
        const adopting = user;
        user = await this.prisma.$transaction(async (tx) => {
          if (!adopting.emailVerified) await discardUnverifiedCredentials(tx as any, adopting.id);
          return tx.user.update({
            where: { id: adopting.id },
            data: {
              externalAuthId: hackClubUser.id,
              ...(adopting.emailVerified
                ? {}
                : { emailVerified: true, emailVerifiedAt: new Date() })
            }
          });
        });
        this.invalidateUserCache(previous);
        this.invalidateUserCache(user);
      } else {
        const nameParts = hackClubUser.name.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || null;

        const baseUsername = sanitizeUsername(hackClubUser.email.split('@')[0]);
        let username = baseUsername;
        let counter = 1;

        while (await this.prisma.user.findUnique({ where: { username } })) {
          username = `${baseUsername}${counter}`;
          counter++;
        }

        user = await this.prisma.user.create({
          data: {
            externalAuthId: hackClubUser.id,
            email: hackClubUser.email,
            username,
            firstName,
            lastName,
            // Hack Club OAuth asserts the email; mark it verified so the user
            // can accept org invitations without a separate email flow.
            emailVerified: true,
            emailVerifiedAt: new Date()
          }
        });
        void this.audit.log({
          action: 'user.signed_up',
          actorUserId: user.id,
          actorEmail: user.email,
          targetType: 'user',
          targetId: user.id,
          metadata: { signup_method: 'hackclub_oauth' }
        });
      }
    } else {
      // Only sync email; do not overwrite firstName/lastName
      // as the user may have manually updated them via profile settings.
      user = await this.prisma.user.update({
        where: { externalAuthId: hackClubUser.id },
        data: {
          email: hackClubUser.email,
          // Backfill verification for existing Hack Club OAuth users created
          // before email was auto-verified.
          ...(user.emailVerified ? {} : { emailVerified: true, emailVerifiedAt: new Date() })
        }
      });
    }

    // Import a Gravatar/Libravatar picture if they have one. Deliberately not
    // awaited: sign-in must not block on an outbound probe to a third party,
    // and the generated mascot already covers the gap until it lands.
    void this.ensureImageUrl(user).catch(() => {});

    return user;
  }

  async findByExternalAuthId(externalAuthId: string) {
    const cached = this.cacheGet(externalAuthId);
    if (cached) return cached;
    const user = await this.prisma.user.findUnique({ where: { externalAuthId } });
    if (user) {
      this.cacheSet(externalAuthId, user);
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
      if (user.externalAuthId) this.cacheSet(user.externalAuthId, user);
    }
    return user;
  }

  /**
   * Resolve a user's picture, importing one from an email avatar service on
   * first sight. Fire-and-forget from auth paths: the caller should not wait on
   * an outbound HTTP probe, and a miss just leaves the generated mascot up.
   */
  async ensureImageUrl(user: any): Promise<string | null> {
    if (!user?.id || !user?.email) return user?.imageUrl || null;
    const resolved = await this.emailAvatar.ensure({
      id: user.id,
      email: user.email,
      imageUrl: user.imageUrl ?? null,
      imageSource: user.imageSource ?? null,
      avatarCheckedAt: user.avatarCheckedAt ?? null
    });
    if (resolved && resolved !== user.imageUrl) this.invalidateUserCache(user);
    return resolved;
  }

  async getUserIdFromExternalAuthId(externalAuthId: string): Promise<string> {
    const user = await this.findByExternalAuthId(externalAuthId);
    if (!user) {
      throw new Error(`User not found for Hack Club ID: ${externalAuthId}`);
    }
    return user.id;
  }

  async findByIdOrExternalAuthId(identifier: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(identifier)) {
      return this.findById(identifier);
    }
    return this.findByExternalAuthId(identifier);
  }

  async findOrCreateByClerkId(
    identifier: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    let user = await this.findByIdOrExternalAuthId(identifier);

    if (!user && userData?.email) {
      // Try to find by email first
      user = await this.prisma.user.findUnique({
        where: { email: userData.email }
      });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const identifierIsUuid = uuidRegex.test(identifier);

      if (user) {
        // Link the externalAuthId to the existing user, but never overwrite it
        // with a UUID. Callers pass `req.user.sub` here, which SuperAdminGuard
        // has already resolved to the DB UUID for OAuth users. Writing that
        // UUID into `externalAuthId` clobbers the real Hack Club ID and breaks
        // every future SuperAdminGuard lookup (`findUnique({ externalAuthId })`
        // returns null → `dbUserId` falls back to `payload.sub` (a HCID) →
        // membership queries run against a non-UUID userId → 403 "Not a
        // member of this organization" forever, until the user logs out.
        const previous = user;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            ...(identifierIsUuid ? {} : { externalAuthId: identifier }),
            ...(userData.firstName && { firstName: userData.firstName }),
            ...(userData.lastName && { lastName: userData.lastName }),
            // Provenance matters even on this legacy path: an imageUrl with no
            // source recorded looks 'never resolved' to the email-avatar lookup,
            // which would then feel free to overwrite it.
            ...(userData.imageUrl && { imageUrl: userData.imageUrl, imageSource: 'upload' })
          }
        });
        this.invalidateUserCache(previous);
        this.invalidateUserCache(user);
      } else {
        // No existing record by id, externalAuthId, or email. If the identifier
        // looks like a UUID we cannot legitimately create a Hack Club–linked
        // user from it: bail out so we don't write garbage into externalAuthId.
        if (identifierIsUuid) return null;

        // Create a new user with the (presumably-real) Hack Club identifier.
        const baseUsername = sanitizeUsername(userData.username || userData.email.split('@')[0]);
        let username = baseUsername;
        let counter = 1;

        while (await this.prisma.user.findUnique({ where: { username } })) {
          username = `${baseUsername}${counter}`;
          counter++;
        }

        user = await this.prisma.user.create({
          data: {
            externalAuthId: identifier,
            email: userData.email,
            username,
            firstName: userData.firstName || null,
            lastName: userData.lastName || null,
            imageUrl: userData.imageUrl || null,
            ...(userData.imageUrl ? { imageSource: 'upload' } : {})
          }
        });
        void this.audit.log({
          action: 'user.signed_up',
          actorUserId: user.id,
          actorEmail: user.email,
          targetType: 'user',
          targetId: user.id,
          metadata: { signup_method: 'clerk_id' }
        });
      }
    }

    return user;
  }

  async updateProfile(
    userId: string,
    data: {
      firstName?: string | null;
      lastName?: string | null;
      username?: string;
      setupCompleted?: boolean;
      imageUrl?: string | null;
      imageSource?: string | null;
    }
  ) {
    // If username is being updated, check format and uniqueness
    if (data.username !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,39}$/.test(data.username)) {
        throw new BadRequestException(
          'Username may only contain letters, numbers, underscores, and hyphens (max 39 characters)'
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
        ...(data.imageSource !== undefined && { imageSource: data.imageSource })
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        imageSource: true,
        externalAuthId: true,
        setupCompleted: true,
        seenUpdates: true
      }
    });
    this.invalidateUserCache(updated);
    return updated;
  }

  async markUpdateSeen(userId: string, updateId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(updateId)) {
      throw new BadRequestException('Invalid update id');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, externalAuthId: true, seenUpdates: true }
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.seenUpdates.includes(updateId)) {
      return { seenUpdates: user.seenUpdates };
    }

    const next = [...user.seenUpdates, updateId].slice(-MAX_SEEN_UPDATES);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { seenUpdates: next },
      select: { seenUpdates: true }
    });
    this.invalidateUserCache(user);
    return { seenUpdates: updated.seenUpdates };
  }
}
