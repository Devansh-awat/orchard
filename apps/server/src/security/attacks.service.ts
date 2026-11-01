import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VictoriaLogsService } from '../logs/victoria-logs.service';
import { buildIpCounts, buildIpSeries, buildSuspicious } from '../logs/logsql';
import {
  FLOOD_MEDIAN_RATIO,
  FLOOD_MIN_IPS,
  FLOOD_MIN_REQUESTS,
  detectAttacks,
  foldInternalSources,
  internalIp,
  maskIp,
  type AccessRecord,
  type AttackKind,
  type AttackReport,
  type AttackSource
} from './attack-signals';

export function floodIps(counts: { ip: string; requests: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (counts.length < FLOOD_MIN_IPS) return out;
  const sorted = counts.map((c) => c.requests).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  for (const c of counts) {
    if (c.requests >= FLOOD_MIN_REQUESTS && c.requests > median * FLOOD_MEDIAN_RATIO) {
      out.set(c.ip, c.requests);
    }
  }
  return out;
}

export function maskReport(report: AttackReport): AttackReport {
  return {
    ...report,
    topSources: report.topSources.map((s) => (s.hidden ? s : { ...s, ip: maskIp(s.ip) })),
    samples: report.samples.map((s) => ({ ...s, ip: maskIp(s.ip) }))
  };
}

@Injectable()
export class AttacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VictoriaLogsService
  ) {}

  get available(): boolean {
    return this.store.configured;
  }

  private async target(deploymentId: string) {
    const d = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        namespace: true,
        projectId: true
      }
    });
    if (!d?.namespace) throw new NotFoundException('Deployment not found');
    return d;
  }

  async report(
    deploymentId: string,
    opts: { start: number; end: number; canEdit: boolean }
  ): Promise<AttackReport> {
    const d = await this.target(deploymentId);
    const scope = { namespace: d.namespace, app: d.name, start: opts.start, end: opts.end };
    const bucketMs = Math.max(60_000, Math.round((opts.end - opts.start) / 60));
    const [rows, counts] = await Promise.all([
      this.store.query(buildSuspicious(scope)),
      this.store.query(buildIpCounts(scope))
    ]);
    const records: AccessRecord[] = rows.map((r) => ({
      t: Date.parse(r._time),
      clientIp: r.client_ip ?? '',
      method: r.method ?? '',
      path: r.path ?? '',
      status: Number(r.status) || 0,
      userAgent: r.user_agent ?? '',
      host: r.host ?? ''
    }));
    const detected = detectAttacks(records, { start: opts.start, end: opts.end, bucketMs });
    const flooding = floodIps(
      counts
        .map((c) => ({ ip: c.client_ip ?? '', requests: Number(c.requests) || 0 }))
        .filter((c) => !internalIp(c.ip))
    );
    const report = await this.withFloods(detected, flooding, scope, bucketMs);
    return opts.canEdit ? report : maskReport(report);
  }

  private async withFloods(
    detected: AttackReport,
    flooding: Map<string, number>,
    scope: { namespace: string; app: string; start: number; end: number },
    bucketMs: number
  ): Promise<AttackReport> {
    const byKind = { ...detected.byKind, flood: 0 };
    const series = detected.series.map((b) => ({ ...b, flood: 0 }));
    const sources = new Map<string, AttackSource>(
      detected.topSources.map((s) => [s.ip, { ...s, kinds: s.kinds.filter((k) => k !== 'flood') }])
    );
    if (flooding.size > 0) {
      for (const [ip, requests] of flooding) {
        byKind.flood += requests;
        const existing = sources.get(ip);
        if (existing) {
          existing.count = Math.max(existing.count, requests);
          existing.kinds = [...new Set<AttackKind>([...existing.kinds, 'flood'])];
        } else {
          sources.set(ip, { ip, count: requests, kinds: ['flood'] });
        }
      }
      const ips = [...flooding.keys()].slice(0, 50);
      const rows = await this.store.query(buildIpSeries(scope, ips, bucketMs)).catch(() => []);
      for (const r of rows) {
        const t = Date.parse(r._time);
        const bucket = series.find((b) => b.t <= t && t < b.t + bucketMs);
        if (bucket) bucket.flood += Number(r.requests) || 0;
      }
    }
    return {
      byKind,
      series,
      topSources: foldInternalSources(
        [...sources.values()].filter((s) => s.kinds.length > 0)
      ).slice(0, 20),
      samples: detected.samples.filter((s) => s.kind !== 'flood')
    };
  }
}
