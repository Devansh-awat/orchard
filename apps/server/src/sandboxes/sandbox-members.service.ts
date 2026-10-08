import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { SandboxMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SandboxAccess, SandboxRole } from './sandbox-access.service';
import { SandboxLiveService } from './live/sandbox-live.service';
import { LIVE_MAX_COMMENT_CHARS, TokenBucket, isChatId, sanitizeText } from './live/live-protocol';
import { OPENCODE_MESSAGE_ID_RE } from './sandbox-opencode-policy';
import { isUuid } from './sandbox-session-commands';

export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  email: true,
  imageUrl: true
} as const;

export interface PublicUserRow {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  imageUrl: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export function publicUser(row: PublicUserRow): PublicUser {
  const full = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
  return { id: row.id, name: full || row.username, avatarUrl: row.imageUrl };
}

export interface SandboxMemberDto {
  user: PublicUser & { email: string };
  role: SandboxMemberRole;
  invitedBy: PublicUser | null;
  createdAt: Date;
}

export interface SandboxCommentDto {
  id: string;
  sessionId: string;
  chatId: string;
  author: PublicUser;
  body: string;
  createdAt: Date;
}

const MEMBER_ROLES: readonly SandboxMemberRole[] = ['viewer', 'collaborator'];
const MAX_MEMBERS = 50;
const COMMENT_PAGE = 200;
const EMAIL_RE = /^[^\s@]{1,128}@[^\s@]{1,253}$/;

function parseRole(value: unknown): SandboxMemberRole {
  if (typeof value !== 'string' || !MEMBER_ROLES.includes(value as SandboxMemberRole)) {
    throw new BadRequestException('role must be viewer or collaborator');
  }
  return value as SandboxMemberRole;
}

export interface RecordedPrompt {
  sandboxId: string;
  sessionKey: string | null;
  userId: string;
  chatId: string;
  messageId: string;
}

export type PromptListener = (prompt: RecordedPrompt) => Promise<unknown>;

@Injectable()
export class SandboxMembersService {
  private readonly commentLimits = new Map<string, TokenBucket>();

  private promptListener: PromptListener | null = null;

  setPromptListener(listener: PromptListener | null): void {
    this.promptListener = listener;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: SandboxLiveService
  ) {
    this.live.setCommentSink((input) =>
      this.createComment(input.sandboxId, input.sid, input.userId, {
        chatId: input.chatId,
        body: input.body
      })
    );
  }

  private toMember(row: {
    role: SandboxMemberRole;
    createdAt: Date;
    user: PublicUserRow;
    invitedBy: PublicUserRow | null;
  }): SandboxMemberDto {
    return {
      user: { ...publicUser(row.user), email: row.user.email },
      role: row.role,
      invitedBy: row.invitedBy ? publicUser(row.invitedBy) : null,
      createdAt: row.createdAt
    };
  }

  async list(access: SandboxAccess): Promise<{
    owner: (PublicUser & { email: string }) | null;
    members: SandboxMemberDto[];
    myRole: SandboxRole;
  }> {
    const [owner, rows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: access.sandbox.userId },
        select: PUBLIC_USER_SELECT
      }),
      this.prisma.sandboxMember.findMany({
        where: { sandboxId: access.sandbox.id },
        orderBy: { createdAt: 'asc' },
        select: {
          role: true,
          createdAt: true,
          user: { select: PUBLIC_USER_SELECT },
          invitedBy: { select: PUBLIC_USER_SELECT }
        }
      })
    ]);
    const showEmails = access.role === 'owner' || access.orgAdmin;
    const members = rows.map((row) => this.toMember(row));
    return {
      owner: owner ? { ...publicUser(owner), email: showEmails ? owner.email : '' } : null,
      members: showEmails
        ? members
        : members.map((m) => ({ ...m, user: { ...m.user, email: '' } })),
      myRole: access.role
    };
  }

  private async resolveInvitee(
    organizationId: string,
    body: { userId?: unknown; email?: unknown }
  ): Promise<PublicUserRow> {
    let user: PublicUserRow | null = null;
    if (typeof body.userId === 'string' && body.userId) {
      if (!isUuid(body.userId)) throw new BadRequestException('userId must be a UUID');
      user = await this.prisma.user.findUnique({
        where: { id: body.userId },
        select: PUBLIC_USER_SELECT
      });
    } else if (typeof body.email === 'string' && body.email.trim()) {
      const email = body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new BadRequestException('email is not valid');
      user = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: PUBLIC_USER_SELECT
      });
    } else {
      throw new BadRequestException('Pass userId or email');
    }
    const member = user
      ? await this.prisma.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId, userId: user.id } },
          select: { role: true }
        })
      : null;
    if (!user || !member) {
      throw new NotFoundException('No one in this organization matches that user');
    }
    return user;
  }

  async add(
    access: SandboxAccess,
    actor: { id: string; email: string | null },
    body: { userId?: unknown; email?: unknown; role?: unknown }
  ): Promise<SandboxMemberDto> {
    const sandbox = access.sandbox;
    if (!sandbox.organizationId) {
      throw new BadRequestException('Only sandboxes in an organization can be shared');
    }
    const role = parseRole(body.role);
    const invitee = await this.resolveInvitee(sandbox.organizationId, body);
    if (invitee.id === sandbox.userId) {
      throw new BadRequestException('The owner already has full access');
    }
    const count = await this.prisma.sandboxMember.count({ where: { sandboxId: sandbox.id } });
    const existing = await this.prisma.sandboxMember.findUnique({
      where: { sandboxId_userId: { sandboxId: sandbox.id, userId: invitee.id } },
      select: { id: true }
    });
    if (!existing && count >= MAX_MEMBERS) {
      throw new BadRequestException(`A sandbox can be shared with at most ${MAX_MEMBERS} people`);
    }
    const row = await this.prisma.sandboxMember.upsert({
      where: { sandboxId_userId: { sandboxId: sandbox.id, userId: invitee.id } },
      create: { sandboxId: sandbox.id, userId: invitee.id, role, invitedById: actor.id },
      update: { role },
      select: {
        role: true,
        createdAt: true,
        user: { select: PUBLIC_USER_SELECT },
        invitedBy: { select: PUBLIC_USER_SELECT }
      }
    });
    this.audit
      .log({
        action: existing ? 'sandbox.member.update' : 'sandbox.member.add',
        actorUserId: actor.id,
        actorEmail: actor.email,
        organizationId: sandbox.organizationId,
        targetType: 'sandbox',
        targetId: sandbox.id,
        targetLabel: sandbox.name,
        metadata: { memberUserId: invitee.id, memberEmail: invitee.email, role }
      })
      .catch(() => {});
    await this.live.aclChanged(sandbox.id, invitee.id);
    return this.toMember(row);
  }

  async update(
    access: SandboxAccess,
    actor: { id: string; email: string | null },
    userId: string,
    body: { role?: unknown }
  ): Promise<SandboxMemberDto> {
    const role = parseRole(body.role);
    const sandbox = access.sandbox;
    const existing = await this.prisma.sandboxMember.findUnique({
      where: { sandboxId_userId: { sandboxId: sandbox.id, userId } },
      select: { id: true, role: true }
    });
    if (!existing) throw new NotFoundException('That person is not a member of this sandbox');
    const row = await this.prisma.sandboxMember.update({
      where: { id: existing.id },
      data: { role },
      select: {
        role: true,
        createdAt: true,
        user: { select: PUBLIC_USER_SELECT },
        invitedBy: { select: PUBLIC_USER_SELECT }
      }
    });
    this.audit
      .log({
        action: 'sandbox.member.update',
        actorUserId: actor.id,
        actorEmail: actor.email,
        organizationId: sandbox.organizationId ?? undefined,
        targetType: 'sandbox',
        targetId: sandbox.id,
        targetLabel: sandbox.name,
        metadata: { memberUserId: userId, from: existing.role, role }
      })
      .catch(() => {});
    await this.live.aclChanged(sandbox.id, userId);
    return this.toMember(row);
  }

  async remove(
    access: SandboxAccess,
    actor: { id: string; email: string | null },
    userId: string
  ): Promise<void> {
    const sandbox = access.sandbox;
    const leaving = userId === actor.id;
    if (!leaving && access.role !== 'owner') {
      throw new ForbiddenException('Only the sandbox owner can remove members');
    }
    const existing = await this.prisma.sandboxMember.findUnique({
      where: { sandboxId_userId: { sandboxId: sandbox.id, userId } },
      select: { id: true, role: true }
    });
    if (!existing) throw new NotFoundException('That person is not a member of this sandbox');
    await this.prisma.sandboxMember.delete({ where: { id: existing.id } });
    this.audit
      .log({
        action: leaving ? 'sandbox.member.leave' : 'sandbox.member.remove',
        actorUserId: actor.id,
        actorEmail: actor.email,
        organizationId: sandbox.organizationId ?? undefined,
        targetType: 'sandbox',
        targetId: sandbox.id,
        targetLabel: sandbox.name,
        metadata: { memberUserId: userId, role: existing.role }
      })
      .catch(() => {});
    await this.live.aclChanged(sandbox.id, userId);
  }

  private async requireSession(sandboxId: string, sid: string) {
    if (!isUuid(sid)) throw new BadRequestException('Invalid session id');
    const session = await this.prisma.sandboxConversation.findFirst({
      where: { id: sid, sandboxId },
      select: { id: true, archivedAt: true }
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  private takeCommentToken(userId: string): boolean {
    let bucket = this.commentLimits.get(userId);
    if (!bucket) {
      if (this.commentLimits.size > 10_000) this.commentLimits.clear();
      bucket = new TokenBucket(1, 5);
      this.commentLimits.set(userId, bucket);
    }
    return bucket.take();
  }

  async listComments(
    sandboxId: string,
    sid: string,
    since?: string
  ): Promise<{ comments: SandboxCommentDto[] }> {
    await this.requireSession(sandboxId, sid);
    let after: Date | null = null;
    if (since) {
      const parsed = new Date(since);
      if (Number.isNaN(parsed.getTime())) throw new BadRequestException('since must be a date');
      after = parsed;
    }
    const rows = await this.prisma.sandboxSessionMessage.findMany({
      where: { sandboxId, sessionKey: sid, ...(after ? { createdAt: { gt: after } } : {}) },
      orderBy: { createdAt: after ? 'asc' : 'desc' },
      take: COMMENT_PAGE,
      select: {
        id: true,
        chatId: true,
        body: true,
        createdAt: true,
        sessionKey: true,
        user: { select: PUBLIC_USER_SELECT }
      }
    });
    const ordered = after ? rows : rows.reverse();
    return {
      comments: ordered.map((row) => ({
        id: row.id,
        sessionId: row.sessionKey,
        chatId: row.chatId,
        author: publicUser(row.user),
        body: row.body,
        createdAt: row.createdAt
      }))
    };
  }

  async createComment(
    sandboxId: string,
    sid: string,
    userId: string,
    body: { chatId?: unknown; body?: unknown }
  ): Promise<SandboxCommentDto> {
    if (!isChatId(body.chatId)) throw new BadRequestException('chatId is not valid');
    const text = sanitizeText(body.body, LIVE_MAX_COMMENT_CHARS);
    if (text === null || !text.trim()) {
      throw new BadRequestException(`Comments must be 1 to ${LIVE_MAX_COMMENT_CHARS} characters`);
    }
    const session = await this.requireSession(sandboxId, sid);
    if (session.archivedAt) throw new BadRequestException('This session is archived');
    if (!this.takeCommentToken(userId)) {
      throw new HttpException('You are sending messages too quickly', HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = await this.prisma.sandboxSessionMessage.create({
      data: { sandboxId, sessionKey: sid, chatId: body.chatId, userId, body: text },
      select: {
        id: true,
        chatId: true,
        body: true,
        createdAt: true,
        sessionKey: true,
        user: { select: PUBLIC_USER_SELECT }
      }
    });
    const comment: SandboxCommentDto = {
      id: row.id,
      sessionId: row.sessionKey,
      chatId: row.chatId,
      author: publicUser(row.user),
      body: row.body,
      createdAt: row.createdAt
    };
    await this.live.broadcast(sandboxId, { t: 'comment', sid, comment });
    return comment;
  }

  async authors(sandboxId: string, sid: string): Promise<{ authors: Record<string, PublicUser> }> {
    await this.requireSession(sandboxId, sid);
    const rows = await this.prisma.sandboxPromptAuthor.findMany({
      where: { sandboxId, sessionKey: sid },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: { messageId: true, user: { select: PUBLIC_USER_SELECT } }
    });
    const authors: Record<string, PublicUser> = {};
    for (const row of rows) authors[row.messageId] = publicUser(row.user);
    return { authors };
  }

  async recordPrompt(input: {
    sandboxId: string;
    userId: string;
    chatId: string;
    messageId: string;
    directory: string | null;
  }): Promise<boolean> {
    if (!OPENCODE_MESSAGE_ID_RE.test(input.messageId)) return false;
    const existing = await this.prisma.sandboxPromptAuthor.findUnique({
      where: { sandboxId_messageId: { sandboxId: input.sandboxId, messageId: input.messageId } },
      select: { userId: true }
    });
    if (existing) return existing.userId === input.userId;
    const session = await this.prisma.sandboxConversation.findFirst({
      where: {
        sandboxId: input.sandboxId,
        OR: [
          { opencodeSessionId: input.chatId },
          ...(input.directory ? [{ worktreePath: input.directory }] : [])
        ]
      },
      select: { id: true }
    });
    try {
      await this.prisma.sandboxPromptAuthor.create({
        data: {
          sandboxId: input.sandboxId,
          sessionKey: session?.id ?? null,
          opencodeSessionId: input.chatId,
          messageId: input.messageId,
          userId: input.userId
        }
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      throw e;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: PUBLIC_USER_SELECT
    });
    if (user) {
      await this.live.broadcast(input.sandboxId, {
        t: 'prompt',
        sid: session?.id ?? null,
        user: publicUser(user),
        chatId: input.chatId,
        messageId: input.messageId
      });
    }
    if (this.promptListener) {
      await this.promptListener({
        sandboxId: input.sandboxId,
        sessionKey: session?.id ?? null,
        userId: input.userId,
        chatId: input.chatId,
        messageId: input.messageId
      }).catch(() => null);
    }
    return true;
  }

  async coAuthors(
    sandboxId: string,
    sid: string,
    excludeUserId: string
  ): Promise<Array<{ name: string; email: string }>> {
    const rows = await this.prisma.sandboxPromptAuthor.findMany({
      where: { sandboxId, sessionKey: sid, userId: { not: excludeUserId } },
      distinct: ['userId'],
      select: { user: { select: PUBLIC_USER_SELECT } }
    });
    return rows
      .map((row) => ({ name: publicUser(row.user).name, email: row.user.email }))
      .filter((a) => /^[^\s<>@]+@[^\s<>@]+$/.test(a.email) && !/[\r\n<>]/.test(a.name));
  }
}
