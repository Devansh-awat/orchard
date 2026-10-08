import { createHash, randomBytes } from 'crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const SLACK_PROVIDER = 'slack';
export const SLACK_LINK_TTL_MS = 10 * 60 * 1000;

const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function slackExternalId(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function slackLinkUrl(token: string): string {
  const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${frontend}/integrations/slack/link?token=${encodeURIComponent(token)}`;
}

function validIdentity(teamId: string, slackUserId: string): boolean {
  return SLACK_ID_RE.test(teamId) && SLACK_ID_RE.test(slackUserId);
}

@Injectable()
export class SlackLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async mappedUser(teamId: string, slackUserId: string): Promise<string | null> {
    if (!validIdentity(teamId, slackUserId)) return null;
    const row = await this.prisma.userIntegration.findFirst({
      where: { provider: SLACK_PROVIDER, externalId: slackExternalId(teamId, slackUserId) },
      select: { userId: true }
    });
    return row?.userId ?? null;
  }

  async createLink(teamId: string, slackUserId: string, nowMs = Date.now()): Promise<string> {
    if (!validIdentity(teamId, slackUserId)) {
      throw new BadRequestException('Slack did not say who sent this command');
    }
    const token = randomBytes(32).toString('base64url');
    await this.prisma.slackLinkToken.deleteMany({
      where: {
        OR: [{ teamId, slackUserId }, { expiresAt: { lt: new Date(nowMs) } }]
      }
    });
    await this.prisma.slackLinkToken.create({
      data: {
        tokenHash: hashLinkToken(token),
        teamId,
        slackUserId,
        expiresAt: new Date(nowMs + SLACK_LINK_TTL_MS)
      }
    });
    return slackLinkUrl(token);
  }

  async confirm(
    userId: string,
    token: unknown,
    nowMs = Date.now()
  ): Promise<{ connected: true; teamId: string }> {
    const expired = new BadRequestException(
      'This link has expired or was already used. Run /greenhouse link in Slack for a new one.'
    );
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw expired;
    const now = new Date(nowMs);
    const row = await this.prisma.slackLinkToken.findUnique({
      where: { tokenHash: hashLinkToken(token) }
    });
    if (!row || row.usedAt || row.expiresAt.getTime() <= nowMs) throw expired;
    const externalId = slackExternalId(row.teamId, row.slackUserId);
    const taken = await this.prisma.userIntegration.findFirst({
      where: { provider: SLACK_PROVIDER, externalId, userId: { not: userId } },
      select: { id: true }
    });
    if (taken) {
      throw new ConflictException(
        'That Slack account is linked to another Orchard user. Run /greenhouse unlink in Slack first.'
      );
    }
    const claimed = await this.prisma.slackLinkToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now }
    });
    if (claimed.count !== 1) throw expired;
    try {
      await this.prisma.userIntegration.upsert({
        where: { userId_provider: { userId, provider: SLACK_PROVIDER } },
        create: { userId, provider: SLACK_PROVIDER, externalId, workspaceName: row.teamId },
        update: { externalId, workspaceName: row.teamId, secret: null }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('That Slack account is linked to another Orchard user.');
      }
      throw e;
    }
    return { connected: true, teamId: row.teamId };
  }

  async unlinkSlackIdentity(teamId: string, slackUserId: string): Promise<boolean> {
    if (!validIdentity(teamId, slackUserId)) return false;
    const removed = await this.prisma.userIntegration.deleteMany({
      where: { provider: SLACK_PROVIDER, externalId: slackExternalId(teamId, slackUserId) }
    });
    await this.prisma.slackLinkToken.deleteMany({ where: { teamId, slackUserId } });
    return removed.count > 0;
  }

  async unlinkUser(userId: string): Promise<{ connected: false }> {
    await this.prisma.userIntegration.deleteMany({ where: { userId, provider: SLACK_PROVIDER } });
    return { connected: false };
  }
}
