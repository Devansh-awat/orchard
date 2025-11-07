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
      const nameParts = hackClubUser.name.split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || null;

      user = await this.prisma.user.update({
        where: { hackClubId: hackClubUser.id },
        data: {
          email: hackClubUser.email,
          firstName,
          lastName,
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

  async findOrCreateByClerkId(identifier: string, userData?: any) {
    return this.findByIdOrHackClubId(identifier);
  }

  async syncImageUrlFromClerk(hackClubId: string): Promise<string | null> {
    return null;
  }

  async updateProfile(userId: string, data: { firstName?: string; lastName?: string; username?: string }) {
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
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        hackClubId: true,
      }
    });
  }
}

