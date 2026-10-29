import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QuotasService } from '../quotas/quotas.service';
import { VictoriaMetricsService, escapeLabel } from '../metrics/victoria-metrics.service';
import { deploymentPodRegex } from '../metrics/pod-selector';
import {
  recommendResources,
  type RightsizingRecommendation,
  type RightsizingSample
} from './recommend';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;
const STEP_SEC = 300;

export function mergeSamples(
  series: {
    key: 'memoryBytes' | 'cpuMilli' | 'throttledPercent';
    points: { x: number; y: number }[];
  }[]
): RightsizingSample[] {
  const byT = new Map<number, RightsizingSample>();
  for (const s of series) {
    for (const p of s.points) {
      if (!Number.isFinite(p.y)) continue;
      const row = byT.get(p.x) ?? { t: p.x };
      row[s.key] = p.y;
      byT.set(p.x, row);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

@Injectable()
export class RightsizingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vm: VictoriaMetricsService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotas: QuotasService
  ) {}

  async recommend(
    deploymentId: string
  ): Promise<RightsizingRecommendation & { unlimited: boolean }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        namespace: true,
        projectId: true,
        image: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true
      }
    });
    if (!deployment?.namespace) throw new NotFoundException('Deployment not found');
    const unlimited =
      deployment.cpuRequestMilli === 0 &&
      (deployment.memoryRequestBytes == null || deployment.memoryRequestBytes === BigInt(0));
    const current = await this.quotas.resolvePodResources(
      deployment.projectId,
      {
        cpuRequestMilli: deployment.cpuRequestMilli,
        memoryRequestBytes:
          deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null
      },
      deployment.image
    );

    const now = Date.now();
    const endSec = Math.floor(now / 1000);
    const startSec = endSec - WINDOW_DAYS * 86400;
    const sel = `namespace="${escapeLabel(deployment.namespace)}",pod=~"${deploymentPodRegex(deployment.name)}",container="",image=""`;
    const [memory, cpu, throttle] = await Promise.all([
      this.vm.queryRange(
        `max(sum by (pod) (container_memory_working_set_bytes{${sel}}))`,
        startSec,
        endSec,
        STEP_SEC
      ),
      this.vm.queryRange(
        `max(sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[5m]))) * 1000`,
        startSec,
        endSec,
        STEP_SEC
      ),
      this.vm
        .queryRange(
          `max(100 * sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{${sel}}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{${sel}}[5m])))`,
          startSec,
          endSec,
          STEP_SEC
        )
        .catch(() => [])
    ]);

    const windowStart = new Date(now - WINDOW_DAYS * DAY_MS);
    const dayAgo = new Date(now - DAY_MS);
    const [oomTransitions, oomPods, restartsInWindow, restartsLast24h] = await Promise.all([
      this.prisma.podTransition.count({
        where: { deploymentId, reason: 'OOMKilled', at: { gte: windowStart } }
      }),
      this.prisma.pod.count({
        where: {
          deploymentId,
          lastTerminationReason: 'OOMKilled',
          lastTerminatedAt: { gte: windowStart }
        }
      }),
      this.prisma.podTransition.count({
        where: { deploymentId, toStatus: { in: ['crashing', 'failed'] }, at: { gte: windowStart } }
      }),
      this.prisma.podTransition.count({
        where: { deploymentId, toStatus: { in: ['crashing', 'failed'] }, at: { gte: dayAgo } }
      })
    ]);

    const result = recommendResources({
      samples: mergeSamples([
        { key: 'memoryBytes', points: memory },
        { key: 'cpuMilli', points: cpu },
        { key: 'throttledPercent', points: throttle }
      ]),
      current: { cpuLimitMilli: current.cpuMilli, memoryBytes: current.memoryBytes },
      image: deployment.image,
      oomKilled: oomTransitions + oomPods > 0,
      restartsLast24h,
      restartsInWindow,
      now
    });
    return { ...result, unlimited };
  }
}
