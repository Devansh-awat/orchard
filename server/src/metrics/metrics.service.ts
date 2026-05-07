import { Injectable, Logger } from '@nestjs/common';

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
      // millicores: cores × 1000
      cpu: `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container!="",container!="POD"}[${rateWin}s])) * 1000`,
      // bytes
      mem: `sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container!="",container!="POD"})`,
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
