import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { metricDef } from '../alerts/metric-catalogue';
import {
  databaseAnomalies,
  deploymentAnomalies,
  rankAnomalies,
  type Anomaly,
  type DatabaseFacts,
  type DeploymentFacts
} from './anomaly-rules';

const ERROR_WINDOW_MS = 60 * 60 * 1000;
const ALERT_UNITS: Record<string, string> = {
  cpu_percent: '%',
  memory_percent: '%',
  error_rate: '%',
  request_rate: ' req/s',
  latency_avg_ms: ' ms',
  latency_max_ms: ' ms'
};

@Injectable()
export class AnomaliesService {
  constructor(private readonly prisma: PrismaService) {}

  async forProject(projectId: string): Promise<Anomaly[]> {
    const [deployments, databases] = await Promise.all([
      this.prisma.deployment.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.database.findMany({ where: { projectId }, select: { id: true } })
    ]);
    return this.collect(
      deployments.map((d) => d.id),
      databases.map((d) => d.id)
    );
  }

  async forDeployment(id: string): Promise<Anomaly[]> {
    return this.collect([id], []);
  }

  async forDatabase(id: string): Promise<Anomaly[]> {
    return this.collect([], [id]);
  }

  private async collect(deploymentIds: string[], databaseIds: string[]): Promise<Anomaly[]> {
    const now = Date.now();
    const since = new Date(now - ERROR_WINDOW_MS);
    const [
      deployments,
      workloads,
      crash,
      pods,
      alerts,
      releases,
      errors,
      databases,
      dbCrash,
      dbPods
    ] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { id: { in: deploymentIds } },
        select: {
          id: true,
          name: true,
          displayName: true,
          stopped: true,
          replicas: true,
          memoryRequestBytes: true,
          applyError: true,
          buildStatus: true,
          buildError: true,
          project: { select: { organization: { select: { slug: true } } } }
        }
      }),
      this.prisma.k8sWorkload.findMany({
        where: { deploymentId: { in: deploymentIds } },
        select: { deploymentId: true, specReplicas: true, readyReplicas: true }
      }),
      this.prisma.deploymentCrashState.findMany({
        where: { deploymentId: { in: deploymentIds } },
        select: { deploymentId: true, crashingSince: true }
      }),
      this.prisma.pod.findMany({
        where: { deploymentId: { in: deploymentIds } },
        select: {
          deploymentId: true,
          status: true,
          restartCount: true,
          lastTerminationReason: true,
          lastTerminatedAt: true
        }
      }),
      this.prisma.metricAlertState.findMany({
        where: { targetId: { in: deploymentIds }, firingSince: { not: null }, okSince: null },
        select: {
          targetId: true,
          firingSince: true,
          lastValue: true,
          rule: { select: { metric: true, comparator: true, threshold: true } }
        }
      }),
      this.prisma.release.findMany({
        where: { deploymentId: { in: deploymentIds } },
        orderBy: { createdAt: 'desc' },
        select: { deploymentId: true, status: true, reason: true, createdAt: true },
        take: deploymentIds.length * 3
      }),
      this.prisma.errorGroup.findMany({
        where: {
          deploymentId: { in: deploymentIds },
          status: 'unresolved',
          lastSeenAt: { gte: since }
        },
        select: { deploymentId: true, message: true, totalCount: true, lastSeenAt: true },
        orderBy: { totalCount: 'desc' },
        take: 200
      }),
      this.prisma.database.findMany({
        where: { id: { in: databaseIds } },
        select: {
          id: true,
          name: true,
          memoryRequestBytes: true,
          project: { select: { organization: { select: { slug: true } } } }
        }
      }),
      this.prisma.databaseCrashState.findMany({
        where: { databaseId: { in: databaseIds } },
        select: { databaseId: true, crashingSince: true }
      }),
      this.prisma.databasePod.findMany({
        where: { databaseId: { in: databaseIds } },
        select: {
          databaseId: true,
          status: true,
          restartCount: true,
          lastTerminationReason: true,
          lastTerminatedAt: true
        }
      })
    ]);

    const byDep = <T extends { deploymentId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.deploymentId, [...(m.get(r.deploymentId) ?? []), r]);
      return m;
    };
    const workloadById = new Map(workloads.map((w) => [w.deploymentId, w]));
    const crashById = new Map(crash.map((c) => [c.deploymentId, c.crashingSince]));
    const podsById = byDep(pods);
    const alertsById = byDep(alerts.map((a) => ({ ...a, deploymentId: a.targetId })));
    const releasesById = byDep(releases);
    const errorsById = byDep(errors);
    const dbCrashById = new Map(dbCrash.map((c) => [c.databaseId, c.crashingSince]));
    const dbPodsById = new Map<string, typeof dbPods>();
    for (const p of dbPods)
      dbPodsById.set(p.databaseId, [...(dbPodsById.get(p.databaseId) ?? []), p]);

    const out: Anomaly[] = [];
    for (const d of deployments) {
      const slug = d.project.organization.slug;
      const latest = releasesById.get(d.id)?.[0];
      const facts: DeploymentFacts = {
        id: d.id,
        name: d.displayName || d.name,
        stopped: d.stopped,
        replicas: d.replicas,
        memoryBytes: d.memoryRequestBytes != null ? Number(d.memoryRequestBytes) : null,
        crashingSince: crashById.get(d.id) ?? null,
        workload: workloadById.get(d.id) ?? null,
        pods: podsById.get(d.id) ?? [],
        alerts: (alertsById.get(d.id) ?? []).map((a) => {
          const def = metricDef(a.rule.metric);
          const unit = def?.unit ?? ALERT_UNITS[a.rule.metric] ?? '';
          const label = `${def?.label ?? a.rule.metric} ${a.rule.comparator === 'lt' ? 'below' : 'above'} ${a.rule.threshold}${unit}`;
          return { label, lastValue: a.lastValue, firingSince: a.firingSince, unit };
        }),
        failedRelease:
          latest && latest.status === 'failed'
            ? { reason: latest.reason, createdAt: latest.createdAt }
            : null,
        applyError: d.applyError,
        buildStatus: d.buildStatus,
        buildError: d.buildError,
        errorGroups: (errorsById.get(d.id) ?? []).map((g) => ({
          message: g.message,
          count: g.totalCount,
          lastSeenAt: g.lastSeenAt
        })),
        href: `/${slug}/deployments/${d.id}`
      };
      out.push(...deploymentAnomalies(facts, now));
    }
    for (const db of databases) {
      const facts: DatabaseFacts = {
        id: db.id,
        name: db.name,
        crashingSince: dbCrashById.get(db.id) ?? null,
        pods: dbPodsById.get(db.id) ?? [],
        memoryBytes: db.memoryRequestBytes != null ? Number(db.memoryRequestBytes) : null,
        href: `/${db.project.organization.slug}/databases/${db.id}`
      };
      out.push(...databaseAnomalies(facts, now));
    }
    return rankAnomalies(out);
  }
}
