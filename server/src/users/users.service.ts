import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface HackClubUserData {
  id: string;
  email: string;
  name: string;
  slackId?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateByHackClubId(hackClubUser: HackClubUserData) {
    let user = await this.prisma.user.findUnique({
      where: { hackClubId: hackClubUser.id }
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: hackClubUser.email }
      });

      if (user) {
        const nameParts = hackClubUser.name.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || null;

        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            hackClubId: hackClubUser.id,
            firstName,
            lastName,
          }
        });
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
          }
        });
      }
    } else {
      // Only sync email; do not overwrite firstName/lastName
      // as the user may have manually updated them via profile settings.
      user = await this.prisma.user.update({
        where: { hackClubId: hackClubUser.id },
        data: {
          email: hackClubUser.email,
        }
      });
    }

    return user;
  }

  async findByHackClubId(hackClubId: string) {
    return this.prisma.user.findUnique({
      where: { hackClubId }
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id }
    });
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
    } else {
      return this.findByHackClubId(identifier);
    }
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
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            ...(identifierIsUuid ? {} : { hackClubId: identifier }),
            ...(userData.firstName && { firstName: userData.firstName }),
            ...(userData.lastName && { lastName: userData.lastName }),
            ...(userData.imageUrl && { imageUrl: userData.imageUrl }),
          },
        });
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
      }
    }

    return user;
  }

  async syncImageUrlFromClerk(hackClubId: string): Promise<string | null> {
    return null;
  }

  async updateProfile(userId: string, data: { firstName?: string | null; lastName?: string | null; username?: string; setupCompleted?: boolean; imageUrl?: string | null }) {
    // If username is being updated, check for uniqueness
    if (data.username !== undefined) {
      const existingUser = await this.prisma.user.findUnique({
        where: { username: data.username }
      });
      if (existingUser && existingUser.id !== userId) {
        throw new Error('Username is already taken');
      }
    }

    return this.prisma.user.update({
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
  }
}

