import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query
} from '@nestjs/common';
import { GraftUserId, SuperAdmin } from '@orchardlabs/graft-sdk/server';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../core/audit.service';

const PAGE_SIZE = 20;
const MAX_LIMIT = 100;

export interface SandboxLimitRow {
  id: string;
  username: string;
  email: string;
  imageUrl: string | null;
  maxSandboxes: number | null;
}

export function parseMaxSandboxes(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_LIMIT) {
    throw new BadRequestException('maxSandboxes must be an integer between 0 and 100, or null');
  }
  return value;
}

export function pageOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

@Controller('admin/limits')
@SuperAdmin()
export class SandboxLimitsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('page') page?: string
  ): Promise<{ users: SandboxLimitRow[]; total: number }> {
    const term = typeof search === 'string' ? search.trim().slice(0, 200) : '';
    const where = term
      ? {
          OR: [
            { username: { contains: term, mode: 'insensitive' as const } },
            { email: { contains: term, mode: 'insensitive' as const } }
          ]
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { username: 'asc' },
        skip: (pageOf(page) - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          username: true,
          email: true,
          imageUrl: true,
          limit: { select: { maxSandboxes: true } }
        }
      }),
      this.prisma.user.count({ where })
    ]);
    return {
      users: rows.map(({ limit, ...user }) => ({
        ...user,
        maxSandboxes: limit?.maxSandboxes ?? null
      })),
      total
    };
  }

  @Put(':userId')
  async update(
    @GraftUserId() actorId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: { maxSandboxes?: unknown }
  ): Promise<SandboxLimitRow> {
    if (!body || !('maxSandboxes' in body)) {
      throw new BadRequestException('maxSandboxes must be an integer between 0 and 100, or null');
    }
    const maxSandboxes = parseMaxSandboxes(body.maxSandboxes);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, imageUrl: true }
    });
    if (!user) throw new NotFoundException('User not found');
    const previous = await this.prisma.userLimit.findUnique({
      where: { userId },
      select: { maxSandboxes: true }
    });
    if (maxSandboxes === null) {
      await this.prisma.userLimit.deleteMany({ where: { userId } });
    } else {
      await this.prisma.userLimit.upsert({
        where: { userId },
        create: { userId, maxSandboxes },
        update: { maxSandboxes }
      });
    }
    void this.audit
      .log({
        action: 'sandbox.limits.update',
        actorUserId: actorId,
        targetType: 'user',
        targetId: userId,
        targetLabel: user.email,
        metadata: { from: previous?.maxSandboxes ?? null, to: maxSandboxes }
      })
      .catch(() => {});
    return { ...user, maxSandboxes };
  }
}
