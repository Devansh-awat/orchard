import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TIMELINE_KINDS,
  TimelineActor,
  TimelineEntry,
  TimelineKind,
  TimelinePage,
  commitHref,
  decodeCursor,
  describeAudit,
  describeBuildRun,
  describeErrorGroup,
  describePodTransition,
  describeRelease,
  entryId,
  mergeTimeline
} from './timeline-entries';
import {
  ChangeEntry,
  auditChange,
  buildChange,
  clusterEventChange,
  mergeChanges,
  releaseChange
} from './changes';

const CHANGES_LIMIT = 500;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Pending {
  entry: Omit<TimelineEntry, 'actor'>;
  actorUserId: string | null;
}

@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    deploymentId: string,
    opts: { cursor?: string | null; limit?: number; kinds?: TimelineKind[]; canEdit?: boolean }
  ): Promise<TimelinePage> {
    const canEdit = opts.canEdit ?? true;
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const kinds = new Set<TimelineKind>(opts.kinds?.length ? opts.kinds : TIMELINE_KINDS);
    const before = cursor ? new Date(cursor.at + 1) : null;
    const take = limit + 1;

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { githubRepo: true }
    });
    const repoUrl = deployment?.githubRepo?.replace(/\.git$/, '') ?? null;

    const [audits, runs, releases, pods, errors] = await Promise.all([
      kinds.has('audit')
        ? this.prisma.auditLog.findMany({
            where: { deploymentId, ...(before ? { createdAt: { lt: before } } : {}) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take
          })
        : [],
      kinds.has('build')
        ? this.prisma.buildRun.findMany({
            where: {
              deploymentId,
              status: { not: 'succeeded' },
              ...(before ? { createdAt: { lt: before } } : {})
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
              id: true,
              status: true,
              triggerType: true,
              commitSha: true,
              commitMessage: true,
              commitAuthorName: true,
              commitAuthorUsername: true,
              branch: true,
              triggeredById: true,
              detail: true,
              createdAt: true
            }
          })
        : [],
      kinds.has('release')
        ? this.prisma.imageHistory.findMany({
            where: { deploymentId, ...(before ? { createdAt: { lt: before } } : {}) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
              id: true,
              image: true,
              tag: true,
              commitSha: true,
              commitMessage: true,
              commitAuthorName: true,
              commitAuthorUsername: true,
              branch: true,
              buildStartedAt: true,
              buildCompletedAt: true,
              triggerType: true,
              triggeredById: true,
              isActive: true,
              createdAt: true
            }
          })
        : [],
      kinds.has('pod')
        ? this.prisma.podTransition.findMany({
            where: { deploymentId, ...(before ? { at: { lt: before } } : {}) },
            orderBy: [{ at: 'desc' }, { id: 'desc' }],
            take
          })
        : [],
      kinds.has('error')
        ? this.prisma.errorGroup.findMany({
            where: { deploymentId, ...(before ? { firstSeenAt: { lt: before } } : {}) },
            orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
              id: true,
              fingerprint: true,
              type: true,
              message: true,
              status: true,
              totalCount: true,
              firstSeenAt: true,
              firstImageHistoryId: true
            }
          })
        : []
    ]);

    const sources: Pending[][] = [
      audits.map((row): Pending => {
        const d = describeAudit(row);
        return {
          actorUserId: row.actorUserId,
          entry: {
            id: entryId('audit', row.id),
            at: row.createdAt.toISOString(),
            kind: 'audit',
            title: d.title,
            detail: d.detail,
            status: d.status,
            href: null,
            meta: {
              action: row.action,
              actorEmail: canEdit ? row.actorEmail : null,
              targetType: row.targetType,
              targetId: row.targetId,
              targetLabel: row.targetLabel,
              metadata: row.metadata ?? null
            }
          }
        };
      }),
      runs.map((raw): Pending => {
        const run = canEdit ? raw : { ...raw, detail: null };
        const d = describeBuildRun(run);
        return {
          actorUserId: run.triggeredById,
          entry: {
            id: entryId('build', run.id),
            at: run.createdAt.toISOString(),
            kind: 'build',
            title: d.title,
            detail: d.detail,
            status: d.status,
            href: commitHref(repoUrl, run.commitSha),
            meta: {
              runId: run.id,
              buildStatus: run.status,
              triggerType: run.triggerType,
              commitSha: run.commitSha,
              commitMessage: run.commitMessage,
              commitAuthorName: run.commitAuthorName,
              commitAuthorUsername: run.commitAuthorUsername,
              branch: run.branch,
              reason: run.detail
            }
          }
        };
      }),
      releases.map((h): Pending => {
        const d = describeRelease(h);
        return {
          actorUserId: h.triggeredById,
          entry: {
            id: entryId('release', h.id),
            at: h.createdAt.toISOString(),
            kind: 'release',
            title: d.title,
            detail: d.detail,
            status: d.status,
            href: commitHref(repoUrl, h.commitSha),
            meta: {
              imageHistoryId: h.id,
              image: h.image,
              tag: h.tag,
              commitSha: h.commitSha,
              commitMessage: h.commitMessage,
              commitAuthorName: h.commitAuthorName,
              commitAuthorUsername: h.commitAuthorUsername,
              branch: h.branch,
              triggerType: h.triggerType,
              isActive: h.isActive,
              buildStartedAt: h.buildStartedAt?.toISOString() ?? null,
              buildCompletedAt: h.buildCompletedAt?.toISOString() ?? null
            }
          }
        };
      }),
      pods.map((t): Pending => {
        const d = describePodTransition(t);
        return {
          actorUserId: null,
          entry: {
            id: entryId('pod', t.id),
            at: t.at.toISOString(),
            kind: 'pod',
            title: d.title,
            detail: d.detail,
            status: d.status,
            href: null,
            meta: {
              podName: t.podName,
              fromStatus: t.fromStatus,
              toStatus: t.toStatus,
              reason: t.reason,
              exitCode: t.exitCode
            }
          }
        };
      }),
      errors.map((g): Pending => {
        const d = describeErrorGroup(canEdit ? g : { ...g, message: '' });
        return {
          actorUserId: null,
          entry: {
            id: entryId('error', g.id),
            at: g.firstSeenAt.toISOString(),
            kind: 'error',
            title: d.title,
            detail: d.detail,
            status: d.status,
            href: null,
            meta: {
              fingerprint: g.fingerprint,
              errorType: g.type,
              errorStatus: g.status,
              count: g.totalCount,
              firstImageHistoryId: g.firstImageHistoryId
            }
          }
        };
      })
    ];

    const actors = await this.loadActors(sources, canEdit);
    const hydrated = sources.map((source) =>
      source.map(({ entry, actorUserId }) => ({
        ...entry,
        actor: actorUserId ? (actors.get(actorUserId) ?? null) : null
      }))
    );

    return mergeTimeline(hydrated, { limit, cursor });
  }

  async changes(
    deploymentId: string,
    opts: { start: number; end: number; canEdit: boolean }
  ): Promise<{ changes: ChangeEntry[]; truncated: boolean }> {
    const range = { gte: new Date(opts.start), lte: new Date(opts.end) };
    const take = CHANGES_LIMIT + 1;
    const [audits, releases, runs, events] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { deploymentId, createdAt: range },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          action: true,
          createdAt: true,
          targetType: true,
          targetLabel: true,
          metadata: true,
          actorUserId: true
        }
      }),
      this.prisma.release.findMany({
        where: { deploymentId, promotedAt: range },
        orderBy: { promotedAt: 'desc' },
        take,
        select: {
          id: true,
          promotedAt: true,
          status: true,
          reason: true,
          image: true,
          createdById: true,
          imageHistory: { select: { tag: true, commitSha: true, commitMessage: true } }
        }
      }),
      this.prisma.buildRun.findMany({
        where: { deploymentId, status: 'failed', createdAt: range },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          status: true,
          createdAt: true,
          detail: true,
          commitMessage: true,
          triggeredById: true
        }
      }),
      this.prisma.clusterEvent.findMany({
        where: { deploymentId, at: range },
        orderBy: { at: 'desc' },
        take,
        select: {
          id: true,
          kind: true,
          reason: true,
          message: true,
          nodeName: true,
          count: true,
          at: true
        }
      })
    ]);

    const pending: { entry: Omit<ChangeEntry, 'actor'>; actorUserId: string | null }[][] = [
      audits.flatMap((row) => {
        const change = auditChange(row);
        return change ? [{ entry: change, actorUserId: row.actorUserId }] : [];
      }),
      releases.flatMap((row) =>
        row.promotedAt
          ? [
              {
                entry: releaseChange({ ...row, promotedAt: row.promotedAt }),
                actorUserId: row.createdById
              }
            ]
          : []
      ),
      runs.flatMap((row) => {
        const change = buildChange(row);
        return change ? [{ entry: change, actorUserId: row.triggeredById }] : [];
      }),
      events.map((row) => ({ entry: clusterEventChange(row), actorUserId: null }))
    ];
    const actors = await this.loadActors(pending, opts.canEdit);
    const lists = pending.map((list) =>
      list.map(({ entry, actorUserId }) => {
        const actor = actorUserId ? actors.get(actorUserId) : null;
        return {
          ...entry,
          actor: actor
            ? {
                id: actor.id,
                name:
                  [actor.firstName, actor.lastName].filter(Boolean).join(' ') ||
                  actor.username ||
                  'Someone'
              }
            : null
        };
      })
    );
    const truncated = [audits, releases, runs, events].some((l) => l.length > CHANGES_LIMIT);
    return { changes: mergeChanges(lists, CHANGES_LIMIT), truncated };
  }

  private async loadActors(
    sources: { actorUserId: string | null }[][],
    canEdit: boolean
  ): Promise<Map<string, TimelineActor>> {
    const ids = new Set<string>();
    for (const source of sources) {
      for (const { actorUserId } of source) if (actorUserId) ids.add(actorUserId);
    }
    if (ids.size === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(ids) } },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        imageUrl: true
      }
    });
    return new Map(users.map((u) => [u.id, canEdit ? u : { ...u, email: null }]));
  }
}
