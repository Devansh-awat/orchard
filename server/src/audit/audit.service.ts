import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditMetadataValue = string | number | boolean | null | [unknown, unknown];

export interface AuditLogInput {
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  deploymentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, AuditMetadataValue> | null;
}

export interface AuditQueryOptions {
  scope:
    | { kind: 'global' }
    | { kind: 'organization'; organizationId: string }
    | { kind: 'project'; projectId: string }
    | { kind: 'deployment'; deploymentId: string };
  cursor?: string | null;
  limit?: number;
  action?: string;
}

const RETENTION_DAYS = 180;
const METADATA_VALUE_MAX_LEN = 256;
const METADATA_MAX_KEYS = 24;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an audit entry. Best-effort: errors are logged, never thrown.
   */
  async log(input: AuditLogInput): Promise<void> {
    try {
      const sanitized = this.sanitizeMetadata(input.metadata);
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          actorUserId: input.actorUserId ?? null,
          actorEmail: input.actorEmail ?? null,
          organizationId: input.organizationId ?? null,
          projectId: input.projectId ?? null,
          deploymentId: input.deploymentId ?? null,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          targetLabel: input.targetLabel ? input.targetLabel.slice(0, 255) : null,
          ...(sanitized !== undefined ? { metadata: sanitized } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record audit log "${input.action}": ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Build a `{field: [old, new]}` diff with only changed primitive fields, capped in size.
   * Returns null if no changes.
   */
  diff<T extends Record<string, any>>(before: T | null | undefined, after: T | null | undefined, fields: (keyof T)[]): Record<string, [unknown, unknown]> | null {
    if (!before || !after) return null;
    const out: Record<string, [unknown, unknown]> = {};
    for (const field of fields) {
      const a = before[field];
      const b = after[field];
      if (a !== b) {
        out[String(field)] = [this.truncate(a), this.truncate(b)];
      }
    }
    return Object.keys(out).length ? out : null;
  }

  async query(opts: AuditQueryOptions) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.AuditLogWhereInput = {};
    switch (opts.scope.kind) {
      case 'global':
        break;
      case 'organization':
        where.organizationId = opts.scope.organizationId;
        break;
      case 'project':
        where.projectId = opts.scope.projectId;
        break;
      case 'deployment':
        where.deploymentId = opts.scope.deploymentId;
        break;
    }
    if (opts.action) where.action = opts.action;

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const userIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter((id): id is string => Boolean(id))));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, username: true, firstName: true, lastName: true, imageUrl: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;

    return {
      entries: trimmed.map((row) => ({
        ...row,
        actor: row.actorUserId ? userMap.get(row.actorUserId) ?? null : null,
      })),
      nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
    };
  }

  /**
   * Daily prune of records past retention. @Cron — runs at 03:00 server time.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneExpired() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(`Pruned ${count} audit log entries older than ${RETENTION_DAYS} days`);
      }
    } catch (err) {
      this.logger.warn(`Audit prune failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private truncate(value: unknown): unknown {
    if (typeof value === 'string' && value.length > METADATA_VALUE_MAX_LEN) {
      return value.slice(0, METADATA_VALUE_MAX_LEN) + '…';
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
  }

  private sanitizeMetadata(meta: AuditLogInput['metadata']): Prisma.InputJsonValue | undefined {
    if (!meta) return undefined;
    const keys = Object.keys(meta).slice(0, METADATA_MAX_KEYS);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = meta[k];
      if (Array.isArray(v) && v.length === 2) {
        out[k] = [this.truncate(v[0]), this.truncate(v[1])];
      } else {
        out[k] = this.truncate(v);
      }
    }
    if (Object.keys(out).length === 0) return undefined;
    return out as Prisma.InputJsonValue;
  }
}
