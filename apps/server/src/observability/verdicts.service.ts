import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { LeaseService } from '../coordination/lease.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VictoriaMetricsService, escapeLabel } from '../metrics/victoria-metrics.service';
import { deploymentPodRegex } from '../metrics/pod-selector';
import { ObservabilityService } from './observability.service';
import { deployVerdict, type DeployVerdict, type VerdictWindow } from './verdict';
import { versionLabel } from './changes';

export const VERDICT_WINDOW_MS = 15 * 60_000;
const SWEEP_MS = 60_000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const BATCH = 20;

export interface StoredVerdict extends DeployVerdict {
  version: string;
  previousVersion: string | null;
  before: VerdictWindow & { from: number; to: number };
  after: VerdictWindow & { from: number; to: number };
}

type ReleaseRow = {
  id: string;
  deploymentId: string;
  promotedAt: Date | null;
  settledAt: Date | null;
  imageHistoryId: string | null;
  image: string;
  imageHistory: { tag: string | null; commitSha: string | null } | null;
  deployment: { name: string; namespace: string };
};

const RELEASE_SELECT = {
  id: true,
  deploymentId: true,
  promotedAt: true,
  settledAt: true,
  imageHistoryId: true,
  image: true,
  imageHistory: { select: { tag: true, commitSha: true } },
  deployment: { select: { name: true, namespace: true } }
} as const;

@Injectable()
export class VerdictsService {
  private readonly logger = new Logger(VerdictsService.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly lease: LeaseService,
    private readonly vm: VictoriaMetricsService,
    private readonly observability: ObservabilityService,
    private readonly notifications: NotificationsService
  ) {}

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (!this.lease.canCoordinate || !this.leader.isLeader() || this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = await this.prisma.release.findMany({
        where: {
          verdictAt: null,
          promotedAt: { not: null },
          settledAt: {
            not: null,
            lte: new Date(now - VERDICT_WINDOW_MS),
            gte: new Date(now - GIVE_UP_AFTER_MS)
          }
        },
        orderBy: { settledAt: 'asc' },
        take: BATCH,
        select: RELEASE_SELECT
      });
      for (const release of due) {
        await this.judge(release).catch((err) =>
          this.logger.warn(
            `verdict for release ${release.id} failed: ${err instanceof Error ? err.message : err}`
          )
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async judge(release: ReleaseRow): Promise<void> {
    const promotedAt = release.promotedAt!.getTime();
    const settledAt = release.settledAt!.getTime();
    const previous = await this.prisma.release.findFirst({
      where: { deploymentId: release.deploymentId, promotedAt: { lt: release.promotedAt! } },
      orderBy: { promotedAt: 'desc' },
      select: { image: true, imageHistory: { select: { tag: true, commitSha: true } } }
    });
    const beforeRange = { from: promotedAt - VERDICT_WINDOW_MS, to: promotedAt };
    const afterRange = { from: settledAt, to: settledAt + VERDICT_WINDOW_MS };
    const [before, after, newErrorGroups] = await Promise.all([
      this.measure(release, beforeRange),
      this.measure(release, afterRange),
      release.imageHistoryId
        ? this.prisma.errorGroup.count({
            where: {
              deploymentId: release.deploymentId,
              firstImageHistoryId: release.imageHistoryId
            }
          })
        : Promise.resolve(0)
    ]);
    const version = release.imageHistory
      ? versionLabel(release.imageHistory)
      : (release.image.split(':').pop() ?? release.image);
    const previousVersion = previous
      ? previous.imageHistory
        ? versionLabel(previous.imageHistory)
        : (previous.image.split(':').pop() ?? null)
      : null;
    const verdict = deployVerdict({ before, after, newErrorGroups, version, previousVersion });
    const stored: StoredVerdict = {
      ...verdict,
      version,
      previousVersion,
      before: { ...before, ...beforeRange },
      after: { ...after, ...afterRange }
    };
    const claimed = await this.prisma.release.updateMany({
      where: { id: release.id, verdictAt: null },
      data: { verdict: stored as unknown as Prisma.InputJsonValue, verdictAt: new Date() }
    });
    if (claimed.count === 1 && verdict.status === 'regressed') {
      await this.notifications.notifyDeployRegressed(
        release.deploymentId,
        release.id,
        verdict.summary
      );
    }
  }

  private async measure(
    release: ReleaseRow,
    range: { from: number; to: number }
  ): Promise<VerdictWindow> {
    const at = Math.floor(range.to / 1000);
    const w = `${Math.round((range.to - range.from) / 1000)}s`;
    const sel = `namespace="${escapeLabel(release.deployment.namespace)}",pod=~"${deploymentPodRegex(release.deployment.name)}",container="",image=""`;
    const ingress = await this.observability.ingressFor(release.deploymentId).catch(() => null);
    const p95Query = ingress?.latencyQuantileMs(0.95, w) ?? null;
    const [rps, errorPct, p95, memory, restarts] = await Promise.all([
      ingress ? this.vm.queryInstant(ingress.requestRate(w), at) : Promise.resolve(null),
      ingress ? this.vm.queryInstant(ingress.errorPercent(w), at) : Promise.resolve(null),
      p95Query ? this.vm.queryInstant(p95Query, at) : Promise.resolve(null),
      this.vm.queryInstant(
        `avg_over_time(sum(container_memory_working_set_bytes{${sel}})[${w}:60s])`,
        at
      ),
      this.prisma.podTransition.count({
        where: {
          deploymentId: release.deploymentId,
          toStatus: { in: ['crashing', 'failed'] },
          at: { gte: new Date(range.from), lt: new Date(range.to) }
        }
      })
    ]);
    const seconds = (range.to - range.from) / 1000;
    return {
      requests: rps != null ? Math.round(rps * seconds) : 0,
      errorPct,
      p95Ms: p95,
      rps,
      memoryBytes: memory,
      restarts
    };
  }
}
