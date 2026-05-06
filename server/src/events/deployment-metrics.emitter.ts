import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { OrgEventsService } from './org-events.service';

/**
 * Periodically scrapes K8s metrics-server for deployments belonging to orgs
 * that have at least one active SSE subscriber, and emits `deployment.metrics`
 * events. Replaces the per-client 15s frontend poll: the work happens once
 * server-side and fans out via SSE to everyone watching.
 */
@Injectable()
export class DeploymentMetricsEmitter {
  private readonly logger = new Logger(DeploymentMetricsEmitter.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
    private readonly orgEvents: OrgEventsService,
  ) {}

  @Interval(10_000)
  async tick() {
    if (this.running) return; // prevent overlap if a previous tick is slow
    const watched = this.orgEvents.watchedOrgIds();
    if (watched.length === 0) return;
    this.running = true;
    try {
      await this.scrapeAndEmit(watched);
    } catch (err) {
      this.logger.warn(`metrics tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  private async scrapeAndEmit(orgIds: string[]) {
    const rows = await this.prisma.deployment.findMany({
      where: {
        replicas: { gt: 0 },
        project: { organizationId: { in: orgIds } },
      },
      select: {
        id: true,
        name: true,
        namespace: true,
        projectId: true,
        project: { select: { organizationId: true } },
      },
    });
    // Prisma 6 rejects `{ not: null }`; filter in JS instead of NOT.
    const deployments = rows.filter((d): d is typeof d & { namespace: string } => !!d.namespace);
    if (deployments.length === 0) return;

    // Group by namespace for one metrics fetch per namespace.
    const byNamespace = new Map<string, typeof deployments>();
    for (const d of deployments) {
      if (!d.namespace) continue;
      const arr = byNamespace.get(d.namespace) ?? [];
      arr.push(d);
      byNamespace.set(d.namespace, arr);
    }

    await Promise.all(
      Array.from(byNamespace.entries()).map(async ([namespace, deps]) => {
        // Pull pod-list (for app→pod map) + pod-metrics in parallel.
        const [podsByApp, podMetrics] = await Promise.all([
          this.k8s.listNamespacePodsByApp(namespace),
          this.k8s.getPodMetrics(namespace, ''),
        ]);
        if (!podsByApp || podMetrics.size === 0) return;

        for (const dep of deps) {
          const entry = podsByApp.get(dep.name);
          if (!entry || entry.pods.length === 0) continue;
          let cpu = 0;
          let memory = 0;
          let any = false;
          for (const pod of entry.pods) {
            const m = podMetrics.get(pod.name);
            if (!m) continue;
            cpu += m.cpuUsage;
            memory += m.memoryUsage;
            any = true;
          }
          if (!any) continue;

          this.orgEvents.emit({
            organizationId: dep.project.organizationId,
            type: 'deployment.metrics',
            id: dep.id,
            projectId: dep.projectId,
            payload: { cpu, memory },
          });

          // Persist for historical chart, fire-and-forget.
          this.prisma.deploymentMetric
            .create({
              data: {
                deploymentId: dep.id,
                cpuUsage: cpu,
                memoryUsage: BigInt(memory),
              },
            })
            .catch(() => {});
        }
      }),
    );
  }
}
