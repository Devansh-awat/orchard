import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';

@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, name: string, expiresAt?: Date) {
    const token = `orch_${randomBytes(32).toString('hex')}`;

    const apiToken = await this.prisma.apiToken.create({
      data: {
        name,
        token,
        userId,
        expiresAt,
      },
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
    return true;
  }
}
