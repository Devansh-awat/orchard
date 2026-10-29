import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LogsStoreError, VictoriaLogsService, type LogRow } from './victoria-logs.service';
import {
  buildClients,
  buildLatencySeries,
  buildRecent,
  buildRouteStats,
  buildSlowest,
  type AccessOptions
} from './logsql';

export interface RequestRow {
  t: string;
  method: string;
  host: string;
  path: string;
  route: string;
  status: number;
  durationMs: number;
  bytes: number | null;
  clientIp: string;
  userAgent: string;
  pod: string | null;
}

export interface RouteStat {
  id: string;
  label: string;
  service: string;
  requestRate: number;
  errorRate: number;
  errorPercent: number;
  latencyMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  requests: number;
}

type Point = { x: number; y: number };

const num = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toRequest(row: LogRow): RequestRow {
  return {
    t: row._time,
    method: row.method ?? '',
    host: row.host ?? '',
    path: row.path ?? '',
    route: row.route ?? row.path ?? '',
    status: num(row.status) ?? 0,
    durationMs: num(row.duration_ms) ?? 0,
    bytes: num(row.bytes),
    clientIp: row.client_ip ?? '',
    userAgent: row.user_agent ?? '',
    pod: row.ingress_pod ?? null
  };
}

export function toRouteStats(rows: LogRow[], service: string, seconds: number): RouteStat[] {
  return rows.flatMap((r) => {
    const requests = num(r.requests) ?? 0;
    if (requests <= 0) return [];
    const errors = num(r.errors) ?? 0;
    const label = `${r.host ?? ''}${r.route ?? ''}`;
    return [
      {
        id: label,
        label,
        service,
        requestRate: requests / Math.max(1, seconds),
        errorRate: errors / Math.max(1, seconds),
        errorPercent: (errors / requests) * 100,
        latencyMs: num(r.p95),
        p50: num(r.p50),
        p95: num(r.p95),
        p99: num(r.p99),
        requests
      }
    ];
  });
}

export function toLatency(rows: LogRow[]): { p50: Point[]; p95: Point[]; p99: Point[] } {
  const out = { p50: [] as Point[], p95: [] as Point[], p99: [] as Point[] };
  for (const r of rows) {
    const x = Date.parse(r._time);
    if (!Number.isFinite(x)) continue;
    for (const k of ['p50', 'p95', 'p99'] as const) {
      const y = num(r[k]);
      if (y != null) out[k].push({ x, y });
    }
  }
  return out;
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VictoriaLogsService
  ) {}

  get available(): boolean {
    return this.store.configured;
  }

  private async scope(deploymentId: string, start: number, end: number): Promise<AccessOptions> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });
    if (!deployment?.namespace) throw new LogsStoreError('deployment has no namespace');
    return { namespace: deployment.namespace, app: deployment.name, start, end };
  }

  async routes(deploymentId: string, start: number, end: number, limit = 50): Promise<RouteStat[]> {
    const opts = await this.scope(deploymentId, start, end);
    const rows = await this.store.query(buildRouteStats({ ...opts, limit }));
    return toRouteStats(rows, opts.app, (end - start) / 1000);
  }

  async latency(deploymentId: string, start: number, end: number, stepMs: number) {
    const opts = await this.scope(deploymentId, start, end);
    return toLatency(await this.store.query(buildLatencySeries(opts, stepMs)));
  }

  async slowest(deploymentId: string, start: number, end: number, n = 20): Promise<RequestRow[]> {
    const opts = await this.scope(deploymentId, start, end);
    return (await this.store.query(buildSlowest(opts, n))).map(toRequest);
  }

  async recent(deploymentId: string, start: number, end: number, n = 100): Promise<RequestRow[]> {
    const opts = await this.scope(deploymentId, start, end);
    return (await this.store.query(buildRecent(opts, n))).map(toRequest);
  }

  async clients(deploymentId: string, start: number, end: number, n = 10) {
    const opts = await this.scope(deploymentId, start, end);
    const q = buildClients(opts, n);
    const [ips, agents] = await Promise.all([this.store.query(q.ips), this.store.query(q.agents)]);
    return {
      ips: ips.map((r) => ({ value: r.client_ip ?? '', count: num(r.hits) ?? 0 })),
      agents: agents.map((r) => ({ value: r.user_agent ?? '', count: num(r.hits) ?? 0 }))
    };
  }
}
