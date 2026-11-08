import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { ObservabilityService } from './observability.service';
import { VictoriaLogsService } from '../logs/victoria-logs.service';
import { buildSearch } from '../logs/logsql';
import { rowsToEntries } from '../logs/entries';

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_WINDOW_MINUTES = 10;
const STORE_LINES = 20000;
const MAX_DEPLOYMENTS_PER_SWEEP = 40;
export const MAX_GROUPS_PER_DEPLOYMENT = 500;
export const MAX_GROUPS_PER_PROJECT = 5000;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_STACK_LENGTH = 8000;
export const OVERFLOW_FINGERPRINT = 'overflow';

// Enough to answer "what code am I looking at": the commit for GitHub deploys,
// and who pushed the button for manual ones.
const DEPLOY_SELECT = {
  id: true,
  commitSha: true,
  commitMessage: true,
  branch: true,
  triggerType: true,
  createdAt: true,
  triggeredBy: { select: { username: true } }
} as const;

// Errors are parsed from pod logs server-side on the leader so history keeps
// accumulating across redeploys and whether or not anyone has the tab open.
// Each sweep only counts occurrences newer than the group's last watermark, so
// overlapping windows never double count.
@Injectable()
export class ErrorIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErrorIngestService.name);

  private timer: NodeJS.Timeout | null = null;

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly observability: ObservabilityService,
    private readonly logsStore: VictoriaLogsService
  ) {}

  onModuleInit() {
    if (process.env.ERROR_INGEST_DISABLED === '1') {
      this.logger.log('error ingest disabled by env');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep() {
    if (this.running || !this.leader.isLeader()) return;
    this.running = true;
    try {
      const deployments = await this.prisma.deployment.findMany({
        where: { status: { in: ['running', 'degraded'] } },
        select: { id: true },
        take: MAX_DEPLOYMENTS_PER_SWEEP,
        orderBy: { updatedAt: 'desc' }
      });
      let touched = 0;
      for (const d of deployments) {
        try {
          touched += (await this.ingest(d.id)) ?? 0;
        } catch (err) {
          this.logger.warn(`ingest ${d.id} failed: ${(err as Error).message}`);
        }
      }
      if (touched) this.logger.log(`ingested ${touched} error groups`);
    } finally {
      this.running = false;
    }
  }

  // Ingest-on-read: never let a parse failure break the tab.
  async ingestSafely(deploymentId: string, windowMinutes = SWEEP_WINDOW_MINUTES) {
    try {
      await this.ingest(deploymentId, windowMinutes);
    } catch (err) {
      this.logger.warn(`on-read ingest ${deploymentId} failed: ${(err as Error).message}`);
    }
  }

  async listGroups(deploymentId: string, windowMinutes: number) {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { githubRepo: true, projectId: true }
    });

    // Only people who can actually open this deployment are assignable.
    const members = deployment?.projectId
      ? await this.prisma.projectMember.findMany({
          where: { projectId: deployment.projectId },
          select: { user: { select: { id: true, username: true, imageUrl: true } } }
        })
      : [];
    const groups = await this.prisma.errorGroup.findMany({
      where: { deploymentId, lastSeenAt: { gte: cutoff } },
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
      include: {
        assignee: { select: { id: true, username: true, imageUrl: true } },
        firstImageHistory: { select: DEPLOY_SELECT },
        occurrences: {
          select: {
            count: true,
            imageHistory: { select: DEPLOY_SELECT }
          }
        }
      }
    });

    return {
      repoUrl: deployment?.githubRepo?.replace(/\.git$/, '') ?? null,
      assignable: members.map((m) => m.user),
      errors: groups.map((g) => ({
        fingerprint: g.fingerprint,
        type: g.type,
        message: g.message,
        count: g.totalCount,
        status: g.status,
        firstSeen: g.firstSeenAt.toISOString(),
        lastSeen: g.lastSeenAt.toISOString(),
        assignee: g.assignee,
        githubIssueUrl: g.githubIssueUrl,
        stackTrace: g.sampleStack,
        firstDeploy: g.firstImageHistory ? mapDeploy(g.firstImageHistory) : null,
        deployCount: g.occurrences.length,
        deploys: g.occurrences
          .filter((o) => o.imageHistory)
          .map((o) => ({ ...mapDeploy(o.imageHistory!), count: o.count }))
      }))
    };
  }

  async updateGroup(
    deploymentId: string,
    fingerprint: string,
    body: { status?: string; assigneeId?: string | null },
    actingUserId: string
  ) {
    const allowed = ['unresolved', 'resolved', 'ignored'];
    const data: Record<string, unknown> = {};
    if (body.status) {
      if (!allowed.includes(body.status)) throw new Error('invalid status');
      data.status = body.status;
      data.resolvedAt = body.status === 'resolved' ? new Date() : null;
      data.resolvedById = body.status === 'resolved' ? actingUserId : null;
    }
    if (body.assigneeId !== undefined) {
      if (body.assigneeId === null) {
        data.assigneeId = null;
      } else {
        const deployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { projectId: true }
        });
        const member =
          typeof body.assigneeId === 'string' && deployment?.projectId
            ? await this.prisma.projectMember.findFirst({
                where: { projectId: deployment.projectId, userId: body.assigneeId },
                select: { id: true }
              })
            : null;
        if (!member) throw new BadRequestException('Choose someone who can open this deployment');
        data.assigneeId = body.assigneeId;
      }
    }

    await this.prisma.errorGroup.update({
      where: { deploymentId_fingerprint: { deploymentId, fingerprint } },
      data
    });
    return { ok: true };
  }

  private async storedEntries(deploymentId: string, windowMinutes: number) {
    if (!this.logsStore.configured) return null;
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });
    if (!deployment?.namespace) return null;
    const end = Date.now();
    try {
      const rows = await this.logsStore.query(
        buildSearch({
          namespace: deployment.namespace,
          app: deployment.name,
          kind: 'app',
          start: end - windowMinutes * 60_000,
          end,
          limit: STORE_LINES
        })
      );
      return rows.length ? rowsToEntries(rows) : null;
    } catch {
      return null;
    }
  }

  private findGroup(deploymentId: string, fingerprint: string) {
    return this.prisma.errorGroup.findUnique({
      where: { deploymentId_fingerprint: { deploymentId, fingerprint } },
      select: { id: true, lastSeenAt: true, status: true }
    });
  }

  private async groupCounts(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true }
    });
    const deployments = await this.prisma.errorGroup.count({ where: { deploymentId } });
    const project = deployment?.projectId
      ? await this.prisma.errorGroup.count({
          where: { deployment: { projectId: deployment.projectId } }
        })
      : deployments;
    return { deployment: deployments, project };
  }

  async ingest(deploymentId: string, windowMinutes = SWEEP_WINDOW_MINUTES): Promise<number> {
    const stored = await this.storedEntries(deploymentId, windowMinutes);
    const { errors } = await this.observability.getErrors(deploymentId, windowMinutes, stored);
    if (!errors.length) return 0;

    let savedCount = 0;
    const activeImage = await this.prisma.imageHistory.findFirst({
      where: { deploymentId, isActive: true },
      select: { id: true }
    });

    let counts: { deployment: number; project: number } | null = null;

    for (const group of errors) {
      const lastSeen = new Date(group.lastSeen);
      const firstSeen = new Date(group.firstSeen);
      if (Number.isNaN(lastSeen.getTime()) || Number.isNaN(firstSeen.getTime())) continue;

      let target = group;
      let existing = await this.findGroup(deploymentId, target.fingerprint);
      if (!existing) {
        counts ??= await this.groupCounts(deploymentId);
        if (
          counts.deployment >= MAX_GROUPS_PER_DEPLOYMENT ||
          counts.project >= MAX_GROUPS_PER_PROJECT
        ) {
          target = {
            ...group,
            fingerprint: OVERFLOW_FINGERPRINT,
            type: 'other',
            message: `Further error types, folded together after ${MAX_GROUPS_PER_DEPLOYMENT} distinct errors`
          };
          existing = await this.findGroup(deploymentId, OVERFLOW_FINGERPRINT);
        }
      }

      // Only the slice newer than the watermark is new; overlapping sweeps of
      // the same window would otherwise inflate the count every minute.
      const watermark = existing?.lastSeenAt ?? null;
      let newCount = group.count;
      if (watermark) {
        const fresh = group.samples.some((s) => s.timestamp && new Date(s.timestamp) > watermark);
        newCount = fresh ? group.count : 0;
      }
      if (existing && newCount === 0) continue;
      savedCount++;

      const sampleStack =
        group.samples.find((s) => s.stackTrace)?.stackTrace?.slice(0, MAX_STACK_LENGTH) ?? null;

      const saved = await this.prisma.errorGroup.upsert({
        where: {
          deploymentId_fingerprint: { deploymentId, fingerprint: target.fingerprint }
        },
        create: {
          deploymentId,
          fingerprint: target.fingerprint,
          type: target.type.slice(0, 200),
          message: target.message.slice(0, MAX_MESSAGE_LENGTH),
          totalCount: group.count,
          firstSeenAt: firstSeen,
          lastSeenAt: lastSeen,
          firstImageHistoryId: activeImage?.id ?? null,
          sampleStack
        },
        update: {
          message: target.message.slice(0, MAX_MESSAGE_LENGTH),
          totalCount: { increment: newCount },
          lastSeenAt: lastSeen,
          sampleStack: sampleStack ?? undefined,
          // A group that fires again after being resolved is a regression.
          ...(existing?.status === 'resolved'
            ? { status: 'unresolved', resolvedAt: null, resolvedById: null }
            : {})
        },
        select: { id: true }
      });

      if (!existing && counts) {
        counts.deployment++;
        counts.project++;
      }

      if (activeImage) {
        await this.prisma.errorOccurrence.upsert({
          where: {
            errorGroupId_imageHistoryId: {
              errorGroupId: saved.id,
              imageHistoryId: activeImage.id
            }
          },
          create: {
            errorGroupId: saved.id,
            imageHistoryId: activeImage.id,
            count: group.count,
            firstSeenAt: firstSeen,
            lastSeenAt: lastSeen
          },
          update: {
            count: { increment: newCount },
            lastSeenAt: lastSeen
          }
        });
      }
    }
    return savedCount;
  }
}

function mapDeploy(h: {
  commitSha: string | null;
  commitMessage: string | null;
  branch: string | null;
  triggerType: string | null;
  createdAt: Date;
  triggeredBy: { username: string } | null;
}) {
  return {
    commitSha: h.commitSha,
    commitMessage: h.commitMessage ? h.commitMessage.split('\n')[0] : null,
    branch: h.branch,
    triggerType: h.triggerType,
    triggeredBy: h.triggeredBy?.username ?? null,
    at: h.createdAt.toISOString()
  };
}
