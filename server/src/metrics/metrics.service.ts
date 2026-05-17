import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SeriesPoint = { x: number; y: number };
export type SeriesId = 'cpu' | 'mem' | 'rx' | 'tx';
export type SeriesBundle = Record<SeriesId, SeriesPoint[]>;

type PromMatrix = {
  status: string;
  data?: { resultType: string; result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
};

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly base = process.env.VICTORIAMETRICS_URL
    ?? 'http://victoriametrics.orchard-metrics.svc.cluster.local:8428';

  constructor(private readonly prisma: PrismaService) {}

  // Provisioning view: for every deployment & database in the org, compare its requested
  // resources against the p95 actual usage over the window. Used to surface over/underprovisioning.
  async getOrgActualVsProvisioned(
    organizationId: string,
    rangeSeconds: number = 24 * 3600,
  ): Promise<{
    rows: Array<{
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
    }>;
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
            cpuRequestMilli: true,
            memoryRequestBytes: true,
            replicas: true,
          },
        },
        databases: {
          select: {
            id: true,
            name: true,
            clusterName: true,
            namespace: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true,
          },
        },
      },
    });

    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - rangeSeconds;

    const rows: Array<{
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
    }> = [];

    const tasks: Array<Promise<void>> = [];

    for (const p of projects) {
      for (const d of p.deployments) {
        const requestedCpu = (d.cpuRequestMilli ?? 0) * (d.replicas ?? 1);
        const requestedMem = (d.memoryRequestBytes ? Number(d.memoryRequestBytes) : 0) * (d.replicas ?? 1);
        tasks.push(
          (async () => {
            const [cpu, mem] = await Promise.all([
              this.queryInstant(
                `quantile_over_time(0.95, (sum(rate(container_cpu_usage_seconds_total{namespace="${escapeLabel(p.namespace)}",pod=~"${escapeRegex(d.name)}-.*",container="",image=""}[60s])) * 1000)[${rangeSeconds}s:60s])`,
              ),
              this.queryInstant(
                `quantile_over_time(0.95, sum(container_memory_working_set_bytes{namespace="${escapeLabel(p.namespace)}",pod=~"${escapeRegex(d.name)}-.*",container="",image=""})[${rangeSeconds}s:60s])`,
              ),
            ]);
            const cpuUtil = requestedCpu > 0 && cpu !== null ? cpu / requestedCpu : null;
            const memUtil = requestedMem > 0 && mem !== null ? mem / requestedMem : null;
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
              verdict: classify(cpuUtil, memUtil),
            });
          })(),
        );
      }
      for (const db of p.databases) {
        if (!db.namespace || !db.clusterName) continue;
        const requestedCpu = db.cpuRequestMilli ?? 0;
        const requestedMem = db.memoryRequestBytes ? Number(db.memoryRequestBytes) : 0;
        tasks.push(
          (async () => {
            const [cpu, mem] = await Promise.all([
              this.queryInstant(
                `quantile_over_time(0.95, (sum(rate(container_cpu_usage_seconds_total{namespace="${escapeLabel(db.namespace!)}",pod=~"${escapeRegex(db.clusterName!)}-.*",container="",image=""}[60s])) * 1000)[${rangeSeconds}s:60s])`,
              ),
              this.queryInstant(
                `quantile_over_time(0.95, sum(container_memory_working_set_bytes{namespace="${escapeLabel(db.namespace!)}",pod=~"${escapeRegex(db.clusterName!)}-.*",container="",image=""})[${rangeSeconds}s:60s])`,
              ),
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
              verdict: classify(cpuUtil, memUtil),
            });
          })(),
        );
      }
    }

    await Promise.all(tasks);
    rows.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
    return { rows };
  }

  private async queryInstant(promql: string): Promise<number | null> {
    const params = new URLSearchParams({ query: promql });
    const url = `${this.base}/api/v1/query?${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`VM query ${res.status}: ${await res.text()}`);
        return null;
      }
      const body = (await res.json()) as {
        status: string;
        data?: { resultType: string; result: Array<{ value: [number, string] }> };
      };
      if (body.status !== 'success' || !body.data?.result?.length) return null;
      const v = Number(body.data.result[0].value[1]);
      return Number.isFinite(v) ? v : null;
    } catch (err) {
      this.logger.warn(`VM query failed: ${(err as Error).message}`);
      return null;
    }
  }

  async fetchDeploymentMetrics(args: {
    namespace: string;
    deploymentName: string;
    startMs: number;
    endMs: number;
    stepMs: number;
  }): Promise<SeriesBundle> {
    const ns = escapeLabel(args.namespace);
    const podRe = `${escapeRegex(args.deploymentName)}-.*`;
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
      tx: `sum(rate(container_network_transmit_bytes_total{namespace="${ns}",pod=~"${podRe}"}[${rateWin}s]))`,
    };

    const startSec = Math.floor(args.startMs / 1000);
    const endSec = Math.floor(args.endMs / 1000);

    const [cpu, mem, rx, tx] = await Promise.all([
      this.queryRange(queries.cpu, startSec, endSec, stepSec),
      this.queryRange(queries.mem, startSec, endSec, stepSec),
      this.queryRange(queries.rx,  startSec, endSec, stepSec),
      this.queryRange(queries.tx,  startSec, endSec, stepSec),
    ]);

    return {
      cpu,
      mem: mem.map((p) => ({ x: p.x, y: p.y / (1024 * 1024) })), // bytes → MB
      rx:  rx.map((p)  => ({ x: p.x, y: p.y / 1024 })),          // bytes/s → KB/s
      tx:  tx.map((p)  => ({ x: p.x, y: p.y / 1024 })),
    };
  }

  private async queryRange(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number,
  ): Promise<SeriesPoint[]> {
    const params = new URLSearchParams({
      query: promql,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
    const url = `${this.base}/api/v1/query_range?${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`VM query_range ${res.status}: ${await res.text()}`);
        return [];
      }
      const body = (await res.json()) as PromMatrix;
      if (body.status !== 'success' || !body.data?.result?.length) return [];
      const series = body.data.result[0].values;
      return series.map(([t, v]) => ({ x: t * 1000, y: Number(v) }));
    } catch (err) {
      this.logger.warn(`VM query_range failed: ${(err as Error).message}`);
      return [];
    }
  }
}

function empty(): SeriesBundle {
  return { cpu: [], mem: [], rx: [], tx: [] };
}

function escapeLabel(s: string): string {
  // Inside double-quoted PromQL labels, escape backslash and double-quote.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classify(cpuUtil: number | null, memUtil: number | null): 'over' | 'under' | 'ok' | 'unknown' {
  if (cpuUtil === null && memUtil === null) return 'unknown';
  const worst = Math.max(cpuUtil ?? 0, memUtil ?? 0);
  if (worst > 0.9) return 'under';
  const best = Math.max(cpuUtil ?? 1, memUtil ?? 1);
  if (best < 0.3) return 'over';
  return 'ok';
}
