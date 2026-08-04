import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { ObservabilityService } from './observability.service';

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_WINDOW_MINUTES = 10;
const MAX_DEPLOYMENTS_PER_SWEEP = 40;

// Enough to answer "what code am I looking at": the commit for GitHub deploys,
// and who pushed the button for manual ones.
const DEPLOY_SELECT = {
  id: true,
  commitSha: true,
  commitMessage: true,
  branch: true,
  triggerType: true,
  createdAt: true,
  triggeredBy: { select: { username: true } },
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
        orderBy: { updatedAt: 'desc' },
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
      select: { githubRepo: true, projectId: true },
    });

    // Only people who can actually open this deployment are assignable.
    const members = deployment?.projectId
      ? await this.prisma.projectMember.findMany({
          where: { projectId: deployment.projectId },
          select: { user: { select: { id: true, username: true, imageUrl: true } } },
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
            imageHistory: { select: DEPLOY_SELECT },
          },
        },
      },
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
          .map((o) => ({ ...mapDeploy(o.imageHistory!), count: o.count })),
      })),
    };
  }

  async updateGroup(
    deploymentId: string,
    fingerprint: string,
    body: { status?: string; assigneeId?: string | null },
    actingUserId: string,
  ) {
    const allowed = ['unresolved', 'resolved', 'ignored'];
    const data: Record<string, unknown> = {};
    if (body.status) {
      if (!allowed.includes(body.status)) throw new Error('invalid status');
      data.status = body.status;
      data.resolvedAt = body.status === 'resolved' ? new Date() : null;
      data.resolvedById = body.status === 'resolved' ? actingUserId : null;
    }
    if (body.assigneeId !== undefined) data.assigneeId = body.assigneeId;

    await this.prisma.errorGroup.update({
      where: { deploymentId_fingerprint: { deploymentId, fingerprint } },
      data,
    });
    return { ok: true };
  }

  async ingest(deploymentId: string, windowMinutes = SWEEP_WINDOW_MINUTES): Promise<number> {
    const { errors } = await this.observability.getErrors(deploymentId, windowMinutes);
    if (!errors.length) return 0;

    let savedCount = 0;
    const activeImage = await this.prisma.imageHistory.findFirst({
      where: { deploymentId, isActive: true },
      select: { id: true },
    });

    for (const group of errors) {
      const lastSeen = new Date(group.lastSeen);
      const firstSeen = new Date(group.firstSeen);
      if (Number.isNaN(lastSeen.getTime()) || Number.isNaN(firstSeen.getTime())) continue;

      const existing = await this.prisma.errorGroup.findUnique({
        where: {
          deploymentId_fingerprint: { deploymentId, fingerprint: group.fingerprint },
        },
        select: { id: true, lastSeenAt: true, status: true },
      });

      // Only the slice newer than the watermark is new; overlapping sweeps of
      // the same window would otherwise inflate the count every minute.
      const watermark = existing?.lastSeenAt ?? null;
      let newCount = group.count;
      if (watermark) {
        const fresh = group.samples.some(
          (s) => s.timestamp && new Date(s.timestamp) > watermark,
        );
        newCount = fresh ? group.count : 0;
      }
      if (existing && newCount === 0) continue;
      savedCount++;

      const sampleStack = group.samples.find((s) => s.stackTrace)?.stackTrace ?? null;

      const saved = await this.prisma.errorGroup.upsert({
        where: {
          deploymentId_fingerprint: { deploymentId, fingerprint: group.fingerprint },
        },
        create: {
          deploymentId,
          fingerprint: group.fingerprint,
          type: group.type.slice(0, 200),
          message: group.message,
          totalCount: group.count,
          firstSeenAt: firstSeen,
          lastSeenAt: lastSeen,
          firstImageHistoryId: activeImage?.id ?? null,
          sampleStack,
        },
        update: {
          message: group.message,
          totalCount: { increment: newCount },
          lastSeenAt: lastSeen,
          sampleStack: sampleStack ?? undefined,
          // A group that fires again after being resolved is a regression.
          ...(existing?.status === 'resolved'
            ? { status: 'unresolved', resolvedAt: null, resolvedById: null }
            : {}),
        },
        select: { id: true },
      });

      if (activeImage) {
        await this.prisma.errorOccurrence.upsert({
          where: {
            errorGroupId_imageHistoryId: {
              errorGroupId: saved.id,
              imageHistoryId: activeImage.id,
            },
          },
          create: {
            errorGroupId: saved.id,
            imageHistoryId: activeImage.id,
            count: group.count,
            firstSeenAt: firstSeen,
            lastSeenAt: lastSeen,
          },
          update: {
            count: { increment: newCount },
            lastSeenAt: lastSeen,
          },
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
    at: h.createdAt.toISOString(),
  };
}
