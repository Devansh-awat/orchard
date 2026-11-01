import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { deploymentPodRegex } from './pod-selector';
import { forecastMemoryLimit, linearFit, projection } from './forecast';
import { classifyFromPeaks } from '../rightsizing/recommend';
import { parseMemory } from '../kubernetes/quantity';
import {
  VictoriaMetricsService,
  escapeLabel,
  escapeRegex,
  type GroupedSeries,
  type SeriesPoint
} from './victoria-metrics.service';

export type { SeriesPoint, GroupedSeries };
export type SeriesId = 'cpu' | 'mem' | 'rx' | 'tx';
export type SeriesBundle = Record<SeriesId, SeriesPoint[]>;
export type GroupedBundle = Record<SeriesId, GroupedSeries[]>;
export type DatabaseSeriesId =
  | 'connections'
  | 'tps'
  | 'cacheHit'
  | 'lag'
  | 'size'
  | 'deadlocks'
  | 'disk'
  | 'diskCapacity';
export type DatabaseSeriesBundle = SeriesBundle & Record<DatabaseSeriesId, SeriesPoint[]>;

const PROVISIONING_TTL_MS = 5 * 60_000;
const PROVISIONING_CONCURRENCY = 6;

type ProvisioningReport = Awaited<ReturnType<MetricsService['computeOrgActualVsProvisioned']>>;

async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vm: VictoriaMetricsService
  ) {}

  // Provisioning view: for every deployment & database in the org, compare its requested
  // resources against the p95 actual usage over the window. Used to surface over/underprovisioning.
  private readonly provisioning = new Map<
    string,
    { at: number; value: Promise<ProvisioningReport> }
  >();

  getOrgActualVsProvisioned(
    organizationId: string,
    rangeSeconds: number = 24 * 3600
  ): Promise<ProvisioningReport> {
    const key = `${organizationId}:${rangeSeconds}`;
    const hit = this.provisioning.get(key);
    if (hit && Date.now() - hit.at < PROVISIONING_TTL_MS) return hit.value;
    const value = this.computeOrgActualVsProvisioned(organizationId, rangeSeconds).catch((err) => {
      this.provisioning.delete(key);
      throw err;
    });
    this.provisioning.set(key, { at: Date.now(), value });
    return value;
  }

  private async computeOrgActualVsProvisioned(
    organizationId: string,
    rangeSeconds: number
  ): Promise<{
    rows: {
      kind: 'deployment' | 'database';
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      namespace: string;
      requestedCpuMilli: number;
      requestedMemoryBytes: number;
      actualCpuMilliP95: number | null;
      actualMemoryBytesP95: number | null;
      cpuUtilization: number | null;
      memoryUtilization: number | null;
      verdict: 'over' | 'under' | 'ok' | 'unknown';
    }[];
  }> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        namespace: true,
        deployments: {
          select: {
            id: true,
            name: true,
            namespace: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true,
            replicas: true,
            image: true
          }
        },
        databases: {
          select: {
            id: true,
            name: true,
            clusterName: true,
            namespace: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true
          }
        }
      }
    });

    const rows: {
      kind: 'deployment' | 'database';
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      namespace: string;
      requestedCpuMilli: number;
      requestedMemoryBytes: number;
      actualCpuMilliP95: number | null;
      actualMemoryBytesP95: number | null;
      cpuUtilization: number | null;
      memoryUtilization: number | null;
      verdict: 'over' | 'under' | 'ok' | 'unknown';
    }[] = [];

    const tasks: (() => Promise<void>)[] = [];

    for (const p of projects) {
      for (const d of p.deployments) {
        const ns = d.namespace || p.namespace;
        const requestedCpu = (d.cpuRequestMilli ?? 0) * (d.replicas ?? 1);
        const requestedMem =
          (d.memoryRequestBytes ? Number(d.memoryRequestBytes) : 0) * (d.replicas ?? 1);
        tasks.push(async () => {
          const sel = `namespace="${escapeLabel(ns)}",pod=~"${deploymentPodRegex(d.name)}",container="",image=""`;
          const [cpu, mem, cpuPodP95, cpuPodP99, memPodPeak] = await Promise.all([
            this.vm.queryInstant(
              `quantile_over_time(0.95, (sum(rate(container_cpu_usage_seconds_total{${sel}}[60s])) * 1000)[${rangeSeconds}s:60s])`
            ),
            this.vm.queryInstant(
              `quantile_over_time(0.95, sum(container_memory_working_set_bytes{${sel}})[${rangeSeconds}s:60s])`
            ),
            this.vm.queryInstant(
              `quantile_over_time(0.95, (max(sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[5m]))) * 1000)[${rangeSeconds}s:300s])`
            ),
            this.vm.queryInstant(
              `quantile_over_time(0.99, (max(sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[5m]))) * 1000)[${rangeSeconds}s:300s])`
            ),
            this.vm.queryInstant(
              `max_over_time(max(sum by (pod) (container_memory_working_set_bytes{${sel}}))[${rangeSeconds}s:300s])`
            )
          ]);
          const cpuUtil = requestedCpu > 0 && cpu !== null ? cpu / requestedCpu : null;
          const memUtil = requestedMem > 0 && mem !== null ? mem / requestedMem : null;
          const unlimited = d.cpuRequestMilli === 0;
          rows.push({
            kind: 'deployment',
            id: d.id,
            name: d.name,
            projectId: p.id,
            projectName: p.name,
            namespace: p.namespace,
            requestedCpuMilli: requestedCpu,
            requestedMemoryBytes: requestedMem,
            actualCpuMilliP95: cpu,
            actualMemoryBytesP95: mem,
            cpuUtilization: cpuUtil,
            memoryUtilization: memUtil,
            verdict: unlimited
              ? 'unknown'
              : classifyFromPeaks({
                  cpuP95: cpuPodP95,
                  cpuP99: cpuPodP99,
                  memoryPeak: memPodPeak,
                  current: {
                    cpuLimitMilli: d.cpuRequestMilli,
                    memoryBytes: d.memoryRequestBytes != null ? Number(d.memoryRequestBytes) : null
                  },
                  image: d.image
                })
          });
        });
      }
      for (const db of p.databases) {
        if (!db.namespace || !db.clusterName) continue;
        const requestedCpu = db.cpuRequestMilli ?? 0;
        const requestedMem = db.memoryRequestBytes ? Number(db.memoryRequestBytes) : 0;
        tasks.push(async () => {
          const [cpu, mem] = await Promise.all([
            this.vm.queryInstant(
              `quantile_over_time(0.95, (sum(rate(container_cpu_usage_seconds_total{namespace="${escapeLabel(db.namespace!)}",pod=~"${escapeRegex(db.clusterName!)}-.*",container="",image=""}[60s])) * 1000)[${rangeSeconds}s:60s])`
            ),
            this.vm.queryInstant(
              `quantile_over_time(0.95, sum(container_memory_working_set_bytes{namespace="${escapeLabel(db.namespace!)}",pod=~"${escapeRegex(db.clusterName!)}-.*",container="",image=""})[${rangeSeconds}s:60s])`
            )
          ]);
          const cpuUtil = requestedCpu > 0 && cpu !== null ? cpu / requestedCpu : null;
          const memUtil = requestedMem > 0 && mem !== null ? mem / requestedMem : null;
          rows.push({
            kind: 'database',
            id: db.id,
            name: db.name,
            projectId: p.id,
            projectName: p.name,
            namespace: db.namespace,
            requestedCpuMilli: requestedCpu,
            requestedMemoryBytes: requestedMem,
            actualCpuMilliP95: cpu,
            actualMemoryBytesP95: mem,
            cpuUtilization: cpuUtil,
            memoryUtilization: memUtil,
            verdict: classify(cpuUtil, memUtil)
          });
        });
      }
    }

    await runLimited(tasks, PROVISIONING_CONCURRENCY);
    rows.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
    return { rows };
  }

  async fetchDeploymentMetrics(args: {
    namespace: string;
    deploymentName: string;
    startMs: number;
    endMs: number;
    stepMs: number;
  }): Promise<SeriesBundle> {
    const ns = escapeLabel(args.namespace);
    const podRe = deploymentPodRegex(args.deploymentName);
    const stepSec = Math.max(1, Math.round(args.stepMs / 1000));
    // Rate window must be ≥ 2× scrape interval (30s) so derivatives have
    // enough samples; clamp upward when the user picks a coarse step.
    const rateWin = Math.max(60, stepSec * 2);

    const queries: Record<SeriesId, string> = {
      // millicores: cores × 1000. Read the pod-level cgroup series
      // (container="",image="") instead of summing per-container series —
      // gVisor pods only populate the pod cgroup, not the inner containers.
      // image="" excludes the pause container (which also has container="").
      cpu: `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container="",image=""}[${rateWin}s])) * 1000`,
      // bytes
      mem: `sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container="",image=""})`,
      // bytes/sec
      rx: `sum(rate(container_network_receive_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`,
      tx: `sum(rate(container_network_transmit_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`
    };

    const startSec = Math.floor(args.startMs / 1000);
    const endSec = Math.floor(args.endMs / 1000);

    const [cpu, mem, rx, tx] = await Promise.all([
      this.vm.queryRange(queries.cpu, startSec, endSec, stepSec),
      this.vm.queryRange(queries.mem, startSec, endSec, stepSec),
      this.vm.queryRange(queries.rx, startSec, endSec, stepSec),
      this.vm.queryRange(queries.tx, startSec, endSec, stepSec)
    ]);

    return {
      cpu,
      mem: mem.map((p) => ({ x: p.x, y: p.y / (1024 * 1024) })), // bytes → MB
      rx: rx.map((p) => ({ x: p.x, y: p.y / 1024 })), // bytes/s → KB/s
      tx: tx.map((p) => ({ x: p.x, y: p.y / 1024 }))
    };
  }

  async forecastDeploymentMemory(deployment: {
    id: string;
    name: string;
    namespace: string;
    memoryRequestBytes: bigint | number | null;
  }): Promise<{
    pod: string;
    hitsLimitAt: number;
    slopeBytesPerHour: number;
    confidence: number;
    limitBytes: number;
    projection: SeriesPoint[];
  } | null> {
    const [pods, workload] = await Promise.all([
      this.prisma.pod.findMany({
        where: { deploymentId: deployment.id },
        select: { name: true, createdAt: true, lastTerminatedAt: true }
      }),
      this.prisma.k8sObject.findFirst({
        where: { kind: 'Deployment', namespace: deployment.namespace, name: deployment.name },
        select: { manifest: true }
      })
    ]);
    const manifest = workload?.manifest as
      | {
          spec?: {
            template?: {
              spec?: { containers?: { resources?: { limits?: { memory?: string } } }[] };
            };
          };
        }
      | undefined;
    const declared = manifest?.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory;
    const limitBytes = declared
      ? parseMemory(declared)
      : deployment.memoryRequestBytes != null
        ? Number(deployment.memoryRequestBytes)
        : 0;
    if (!(limitBytes > 0) || pods.length === 0) return null;
    const now = Date.now();
    const endSec = Math.floor(now / 1000);
    const groups = await this.vm.queryRangeGrouped(
      `sum by (pod) (container_memory_working_set_bytes{namespace="${escapeLabel(deployment.namespace)}",pod=~"${deploymentPodRegex(deployment.name)}",container="",image=""})`,
      endSec - 6 * 3600,
      endSec,
      300,
      'pod'
    );
    const started = new Map(
      pods.map((p) => [p.name, Math.max(p.createdAt.getTime(), p.lastTerminatedAt?.getTime() ?? 0)])
    );
    let best: Awaited<ReturnType<MetricsService['forecastDeploymentMemory']>> = null;
    for (const group of groups) {
      const podStartedAt = started.get(group.key);
      if (podStartedAt == null) continue;
      const points = group.points.map((p) => ({ t: p.x, v: p.y }));
      const forecast = forecastMemoryLimit({ points, limitBytes, podStartedAt, now });
      if (!forecast || (best && best.hitsLimitAt <= forecast.hitsLimitAt)) continue;
      best = {
        pod: group.key,
        ...forecast,
        limitBytes,
        projection: projection(points, linearFit(points), forecast.hitsLimitAt).map((p) => ({
          x: p.t,
          y: p.v
        }))
      };
    }
    return best;
  }

  async fetchDeploymentThrottle(args: {
    namespace: string;
    deploymentName: string;
    startMs: number;
    endMs: number;
    stepMs: number;
  }): Promise<SeriesPoint[]> {
    const sel = `namespace="${escapeLabel(args.namespace)}",pod=~"${deploymentPodRegex(args.deploymentName)}",container="",image=""`;
    const stepSec = Math.max(1, Math.round(args.stepMs / 1000));
    const rateWin = Math.max(60, stepSec * 2);
    const query = `100 * sum(rate(container_cpu_cfs_throttled_periods_total{${sel}}[${rateWin}s])) / sum(rate(container_cpu_cfs_periods_total{${sel}}[${rateWin}s]))`;
    const points = await this.vm.queryRange(
      query,
      Math.floor(args.startMs / 1000),
      Math.floor(args.endMs / 1000),
      stepSec
    );
    return points.filter((p) => Number.isFinite(p.y));
  }

  async fetchDatabaseMetrics(args: {
    namespace: string;
    podPrefix: string;
    startMs: number;
    endMs: number;
    stepMs: number;
    dbName?: string | null;
  }): Promise<DatabaseSeriesBundle> {
    const ns = escapeLabel(args.namespace);
    const podRe = `${escapeRegex(args.podPrefix)}-.*`;
    const stepSec = Math.max(1, Math.round(args.stepMs / 1000));
    const rateWin = Math.max(60, stepSec * 2);

    const queries: Record<SeriesId, string> = {
      cpu: `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container="",image=""}[${rateWin}s])) * 1000`,
      mem: `sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container="",image=""})`,
      rx: `sum(rate(container_network_receive_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`,
      tx: `sum(rate(container_network_transmit_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`
    };

    const startSec = Math.floor(args.startMs / 1000);
    const endSec = Math.floor(args.endMs / 1000);

    const [cpu, mem, rx, tx] = await Promise.all([
      this.vm.queryRange(queries.cpu, startSec, endSec, stepSec),
      this.vm.queryRange(queries.mem, startSec, endSec, stepSec),
      this.vm.queryRange(queries.rx, startSec, endSec, stepSec),
      this.vm.queryRange(queries.tx, startSec, endSec, stepSec)
    ]);

    const instance = `namespace="${ns}",pod=~"${escapeRegex(args.podPrefix)}-[0-9]+"`;
    const db = args.dbName ? `,datname="${escapeLabel(args.dbName)}"` : '';
    const pvc = `namespace="${ns}",persistentvolumeclaim=~"${escapeRegex(args.podPrefix)}-[0-9]+"`;
    const hit = `sum(rate(cnpg_pg_stat_database_blks_hit{${instance}${db}}[${rateWin}s]))`;
    const read = `sum(rate(cnpg_pg_stat_database_blks_read{${instance}${db}}[${rateWin}s]))`;
    const extra: Record<DatabaseSeriesId, string> = {
      connections: `sum(cnpg_backends_total{${instance}${db}})`,
      tps: `sum(rate(cnpg_pg_stat_database_xact_commit{${instance}${db}}[${rateWin}s])) + sum(rate(cnpg_pg_stat_database_xact_rollback{${instance}${db}}[${rateWin}s]))`,
      cacheHit: `100 * ${hit} / (${hit} + ${read} > 0)`,
      lag: `max(cnpg_pg_replication_lag{${instance}})`,
      size: `max(cnpg_pg_database_size_bytes{${instance}${db}})`,
      deadlocks: `sum(increase(cnpg_pg_stat_database_deadlocks{${instance}${db}}[${rateWin}s]))`,
      disk: `max(kubelet_volume_stats_used_bytes{${pvc}})`,
      diskCapacity: `max(kubelet_volume_stats_capacity_bytes{${pvc}})`
    };
    const ids = Object.keys(extra) as DatabaseSeriesId[];
    const extraPoints = await Promise.all(
      ids.map((id) =>
        this.vm
          .queryRange(extra[id], startSec, endSec, stepSec)
          .then((points) => points.filter((p) => Number.isFinite(p.y)))
          .catch(() => [] as SeriesPoint[])
      )
    );
    const byId = Object.fromEntries(ids.map((id, i) => [id, extraPoints[i]])) as Record<
      DatabaseSeriesId,
      SeriesPoint[]
    >;
    const toMiB = (points: SeriesPoint[]) =>
      points.map((p) => ({ x: p.x, y: p.y / (1024 * 1024) }));

    return {
      cpu,
      mem: mem.map((p) => ({ x: p.x, y: p.y / (1024 * 1024) })),
      rx: rx.map((p) => ({ x: p.x, y: p.y / 1024 })),
      tx: tx.map((p) => ({ x: p.x, y: p.y / 1024 })),
      ...byId,
      size: toMiB(byId.size),
      disk: toMiB(byId.disk),
      diskCapacity: toMiB(byId.diskCapacity)
    };
  }

  async fetchDeploymentMetricsByPod(args: {
    namespace: string;
    deploymentName: string;
    startMs: number;
    endMs: number;
    stepMs: number;
  }): Promise<GroupedBundle> {
    const ns = escapeLabel(args.namespace);
    const podRe = deploymentPodRegex(args.deploymentName);
    const stepSec = Math.max(1, Math.round(args.stepMs / 1000));
    const rateWin = Math.max(60, stepSec * 2);

    const queries: Record<SeriesId, string> = {
      cpu: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container="",image=""}[${rateWin}s])) * 1000`,
      mem: `sum by (pod) (container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container="",image=""})`,
      rx: `sum by (pod) (rate(container_network_receive_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`,
      tx: `sum by (pod) (rate(container_network_transmit_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`
    };

    const startSec = Math.floor(args.startMs / 1000);
    const endSec = Math.floor(args.endMs / 1000);

    const [cpu, mem, rx, tx] = await Promise.all([
      this.vm.queryRangeGrouped(queries.cpu, startSec, endSec, stepSec, 'pod'),
      this.vm.queryRangeGrouped(queries.mem, startSec, endSec, stepSec, 'pod'),
      this.vm.queryRangeGrouped(queries.rx, startSec, endSec, stepSec, 'pod'),
      this.vm.queryRangeGrouped(queries.tx, startSec, endSec, stepSec, 'pod')
    ]);

    const scale = (g: GroupedSeries[], f: number) =>
      g.map((s) => ({ key: s.key, points: s.points.map((p) => ({ x: p.x, y: p.y / f })) }));

    return {
      cpu,
      mem: scale(mem, 1024 * 1024),
      rx: scale(rx, 1024),
      tx: scale(tx, 1024)
    };
  }
}

function classify(
  cpuUtil: number | null,
  memUtil: number | null
): 'over' | 'under' | 'ok' | 'unknown' {
  if (cpuUtil === null && memUtil === null) return 'unknown';
  const worst = Math.max(cpuUtil ?? 0, memUtil ?? 0);
  if (worst > 0.9) return 'under';
  const best = Math.max(cpuUtil ?? 1, memUtil ?? 1);
  if (best < 0.3) return 'over';
  return 'ok';
}
