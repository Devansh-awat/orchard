import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Sandbox, SandboxConversation, SandboxShareLink } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { requestAuthStorage } from '../auth/request-context';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxAgentService, type SessionTranscript } from './sandbox-agent.service';
import {
  PUBLIC_USER_SELECT,
  publicUser,
  type PublicUser,
  type PublicUserRow
} from './sandbox-members.service';
import { isUuid } from './sandbox-session-commands';
import type { SandboxAccess } from './sandbox-access.service';

export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const DEFAULT_SHARE_HOURS = 24 * 7;
export const MAX_SHARE_HOURS = 24 * 30;
export const MAX_ACTIVE_SHARE_LINKS = 50;
const USE_AUDIT_WINDOW_MS = 10 * 60_000;
const USE_AUDIT_MAX_KEYS = 5000;
const INVALID_LINK = 'This share link is invalid, expired or revoked';

export type ShareLinkState = 'active' | 'expired' | 'revoked';

export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashShareToken(token) };
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function shareTokenMatches(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashShareToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && given.length > 0 && timingSafeEqual(given, stored);
}

export function shareLinkState(
  link: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date()
): ShareLinkState {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function shareExpiry(hours: unknown, now: Date = new Date()): Date {
  if (hours === undefined || hours === null || hours === '') {
    return new Date(now.getTime() + DEFAULT_SHARE_HOURS * 3_600_000);
  }
  const value = typeof hours === 'string' ? Number(hours) : hours;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SHARE_HOURS
  ) {
    throw new BadRequestException(
      `expiresInHours must be a whole number from 1 to ${MAX_SHARE_HOURS}`
    );
  }
  return new Date(now.getTime() + value * 3_600_000);
}

export function shareUrl(token: string): string {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/share/sandbox/${token}`;
}

export interface ShareLinkDto {
  id: string;
  sandboxId: string;
  sessionId: string | null;
  session: { id: string; title: string } | null;
  createdBy: PublicUser | null;
  state: ShareLinkState;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ShareSessionDto {
  id: string;
  title: string;
  repo: string | null;
  branch: string | null;
  baseBranch: string | null;
  status: 'active' | 'archived';
  prUrl: string | null;
  createdAt: Date;
}

type LinkRow = SandboxShareLink & {
  session: { id: string; title: string } | null;
  createdBy: PublicUserRow | null;
};

type ResolvedShare = {
  link: SandboxShareLink & { createdBy: PublicUserRow | null };
  sandbox: Sandbox;
  session: SandboxConversation | null;
};

function toDto(row: LinkRow, now: Date = new Date()): ShareLinkDto {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    session: row.session ? { id: row.session.id, title: row.session.title } : null,
    createdBy: row.createdBy ? publicUser(row.createdBy) : null,
    state: shareLinkState(row, now),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt
  };
}

function toSessionDto(row: SandboxConversation): ShareSessionDto {
  return {
    id: row.id,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.baseBranch,
    status: row.archivedAt ? 'archived' : 'active',
    prUrl: row.prUrl,
    createdAt: row.createdAt
  };
}

const LINK_INCLUDE = {
  session: { select: { id: true, title: true } },
  createdBy: { select: PUBLIC_USER_SELECT }
} as const;

@Injectable()
export class SandboxShareLinksService {
  private readonly auditedUses = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly agent: SandboxAgentService
  ) {}

  async list(sandboxId: string): Promise<{ links: ShareLinkDto[] }> {
    const rows = await this.prisma.sandboxShareLink.findMany({
      where: { sandboxId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: LINK_INCLUDE
    });
    const now = new Date();
    return { links: rows.map((row) => toDto(row, now)) };
  }

  async create(
    access: SandboxAccess,
    actor: { id: string; email: string | null },
    body: { sessionId?: unknown; expiresInHours?: unknown }
  ): Promise<ShareLinkDto & { token: string; url: string }> {
    const sandbox = access.sandbox;
    if (sandbox.desiredState === 'deleted') {
      throw new BadRequestException('Sandbox is being deleted');
    }
    if (!sandbox.organizationId) {
      throw new BadRequestException('Only machines that belong to an organization can be shared');
    }
    let sessionId: string | null = null;
    if (body.sessionId !== undefined && body.sessionId !== null && body.sessionId !== '') {
      if (typeof body.sessionId !== 'string' || !isUuid(body.sessionId)) {
        throw new BadRequestException('Invalid session id');
      }
      sessionId = (await this.workspace.sessionRow(sandbox.id, body.sessionId)).id;
    }
    const now = new Date();
    const expiresAt = shareExpiry(body.expiresInHours, now);
    const active = await this.prisma.sandboxShareLink.count({
      where: { sandboxId: sandbox.id, revokedAt: null, expiresAt: { gt: now } }
    });
    if (active >= MAX_ACTIVE_SHARE_LINKS) {
      throw new ConflictException(
        `This machine already has ${active} active share links; revoke some first`
      );
    }
    const { token, hash } = newShareToken();
    const row = await this.prisma.sandboxShareLink.create({
      data: {
        sandboxId: sandbox.id,
        sessionId,
        createdById: actor.id,
        tokenHash: hash,
        expiresAt
      },
      include: LINK_INCLUDE
    });
    this.audit
      .log({
        action: 'sandbox.share_link.create',
        actorUserId: actor.id,
        actorEmail: actor.email,
        organizationId: sandbox.organizationId,
        targetType: 'sandbox',
        targetId: sandbox.id,
        targetLabel: sandbox.name,
        metadata: { linkId: row.id, sessionId, expiresAt: expiresAt.toISOString() }
      })
      .catch(() => {});
    return { ...toDto(row, now), token, url: shareUrl(token) };
  }

  async revoke(
    access: SandboxAccess,
    actor: { id: string; email: string | null },
    linkId: string
  ): Promise<ShareLinkDto> {
    if (!isUuid(linkId)) throw new BadRequestException('Invalid share link id');
    const existing = await this.prisma.sandboxShareLink.findFirst({
      where: { id: linkId, sandboxId: access.sandbox.id }
    });
    if (!existing) throw new NotFoundException('Share link not found');
    const row = existing.revokedAt
      ? await this.prisma.sandboxShareLink.findUniqueOrThrow({
          where: { id: existing.id },
          include: LINK_INCLUDE
        })
      : await this.prisma.sandboxShareLink.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
          include: LINK_INCLUDE
        });
    if (!existing.revokedAt) {
      this.audit
        .log({
          action: 'sandbox.share_link.revoke',
          actorUserId: actor.id,
          actorEmail: actor.email,
          organizationId: access.sandbox.organizationId,
          targetType: 'sandbox',
          targetId: access.sandbox.id,
          targetLabel: access.sandbox.name,
          metadata: { linkId: row.id, sessionId: row.sessionId }
        })
        .catch(() => {});
    }
    return toDto(row);
  }

  async resolve(
    token: unknown,
    user: { id: string; email: string | null }
  ): Promise<ResolvedShare> {
    await this.rateLimit.checkRateLimit(user.id, 'user', 'sandbox_share');
    if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) {
      throw new NotFoundException(INVALID_LINK);
    }
    const link = await this.prisma.sandboxShareLink.findUnique({
      where: { tokenHash: hashShareToken(token) },
      include: { sandbox: true, session: true, createdBy: { select: PUBLIC_USER_SELECT } }
    });
    if (!link || !shareTokenMatches(token, link.tokenHash)) {
      throw new NotFoundException(INVALID_LINK);
    }
    if (shareLinkState(link) !== 'active' || link.sandbox.desiredState === 'deleted') {
      throw new NotFoundException(INVALID_LINK);
    }
    const ctx = requestAuthStorage.getStore();
    const orgId = link.sandbox.organizationId;
    const org =
      orgId && !(ctx?.tokenProjectIds && ctx.tokenProjectIds.length > 0)
        ? await this.authz.getOrgAccess(orgId, user.id).catch(() => null)
        : null;
    if (!org || org.role === 'guest') {
      throw new ForbiddenException(
        "Share links only open for members of the machine's organization"
      );
    }
    this.recordUse(link, link.sandbox, user);
    const { sandbox, session, ...rest } = link;
    return { link: rest, sandbox, session };
  }

  private recordUse(
    link: SandboxShareLink,
    sandbox: Sandbox,
    user: { id: string; email: string | null }
  ): void {
    const now = Date.now();
    this.prisma.sandboxShareLink
      .update({ where: { id: link.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
    const key = `${link.id}:${user.id}`;
    const last = this.auditedUses.get(key);
    if (last !== undefined && now - last < USE_AUDIT_WINDOW_MS) return;
    if (this.auditedUses.size >= USE_AUDIT_MAX_KEYS) {
      for (const [k, at] of this.auditedUses) {
        if (now - at >= USE_AUDIT_WINDOW_MS) this.auditedUses.delete(k);
      }
      if (this.auditedUses.size >= USE_AUDIT_MAX_KEYS) this.auditedUses.clear();
    }
    this.auditedUses.set(key, now);
    this.audit
      .log({
        action: 'sandbox.share_link.use',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: sandbox.organizationId,
        targetType: 'sandbox',
        targetId: sandbox.id,
        targetLabel: sandbox.name,
        metadata: { linkId: link.id, sessionId: link.sessionId }
      })
      .catch(() => {});
  }

  private async sharedSession(resolved: ResolvedShare, sid: string): Promise<SandboxConversation> {
    if (!isUuid(sid)) throw new BadRequestException('Invalid session id');
    if (resolved.link.sessionId && resolved.link.sessionId !== sid) {
      throw new NotFoundException('Session not found');
    }
    const session =
      resolved.session && resolved.session.id === sid
        ? resolved.session
        : await this.prisma.sandboxConversation.findFirst({
            where: { id: sid, sandboxId: resolved.sandbox.id, slug: { not: null } }
          });
    if (!session || !session.slug || session.sandboxId !== resolved.sandbox.id) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  async view(token: unknown, user: { id: string; email: string | null }) {
    const resolved = await this.resolve(token, user);
    const sessions = resolved.link.sessionId
      ? resolved.session
        ? [resolved.session]
        : []
      : await this.prisma.sandboxConversation.findMany({
          where: { sandboxId: resolved.sandbox.id, slug: { not: null }, archivedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 100
        });
    return {
      link: {
        id: resolved.link.id,
        sessionId: resolved.link.sessionId,
        expiresAt: resolved.link.expiresAt,
        createdBy: resolved.link.createdBy ? publicUser(resolved.link.createdBy) : null
      },
      sandbox: {
        id: resolved.sandbox.id,
        name: resolved.sandbox.name,
        status: resolved.sandbox.status
      },
      sessions: sessions.map(toSessionDto)
    };
  }

  async transcript(
    token: unknown,
    user: { id: string; email: string | null },
    sid: string,
    limit?: unknown
  ): Promise<SessionTranscript> {
    const resolved = await this.resolve(token, user);
    const session = await this.sharedSession(resolved, sid);
    return this.agent.transcript(resolved.sandbox, session.id, { limit });
  }

  async changes(token: unknown, user: { id: string; email: string | null }, sid: string) {
    const resolved = await this.resolve(token, user);
    const session = await this.sharedSession(resolved, sid);
    return this.workspace.changes(resolved.sandbox, { session: session.id });
  }

  async diff(
    token: unknown,
    user: { id: string; email: string | null },
    sid: string,
    file?: string
  ) {
    const resolved = await this.resolve(token, user);
    const session = await this.sharedSession(resolved, sid);
    return this.workspace.diff(resolved.sandbox, file || undefined, { session: session.id });
  }
}
