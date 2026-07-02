import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from './org-events.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';

const PUSH_INTERVAL_MS = 15_000;

@Injectable()
export class MetricsPusherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsPusherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly k8sWorkload: K8sWorkloadService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), PUSH_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.ticking) return;
    const orgIds = this.orgEvents.watchedOrgIds();
    if (orgIds.length === 0) return;
    this.ticking = true;
    try {
      const deployments = await this.prisma.deployment.findMany({
        where: {
          project: { organizationId: { in: orgIds } },
          replicas: { gt: 0 },
        },
        select: {
          id: true,
          namespace: true,
          projectId: true,
          project: { select: { organizationId: true } },
          pods: { select: { name: true } },
        },
      });
      if (deployments.length === 0) return;

      const metrics = await this.k8sWorkload.getAllPodMetrics();
      if (metrics.size === 0) return;

      for (const dep of deployments) {
        let totalCpu = 0;
        let totalMem = 0;
        let matched = 0;
        const pods: Record<string, { cpuUsage: number; memoryUsage: number }> = {};
        for (const pod of dep.pods) {
          const m = metrics.get(`${dep.namespace}/${pod.name}`);
          if (!m) continue;
          matched++;
          totalCpu += m.cpuMilli;
          totalMem += m.memoryBytes;
          pods[pod.name] = { cpuUsage: m.cpuMilli, memoryUsage: m.memoryBytes };
        }
        if (matched === 0) continue;
        this.orgEvents.emitLocal({
          organizationId: dep.project.organizationId,
          type: 'deployment.metrics',
          id: dep.id,
          projectId: dep.projectId,
          payload: { totalCpuUsage: totalCpu, totalMemoryUsage: totalMem, pods },
        });
      }
    } catch (err) {
      this.logger.warn(`metrics push tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }
}
