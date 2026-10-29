import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { VictoriaLogsService } from '../logs/victoria-logs.service';
import { buildIpCounts, buildIpSeries, buildSuspicious } from '../logs/logsql';
import {
  FLOOD_MEDIAN_RATIO,
  FLOOD_MIN_IPS,
  FLOOD_MIN_REQUESTS,
  detectAttacks,
  maskIp,
  type AccessRecord,
  type AttackKind,
  type AttackReport,
  type AttackSource
} from './attack-signals';
import { parseRateLimit, rateLimitPatch, supportsRateLimit } from './rate-limit';
import type { RateLimit } from '../metrics/ingress/types';

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
    topSources: report.topSources.map((s) => ({ ...s, ip: maskIp(s.ip) })),
    samples: report.samples.map((s) => ({ ...s, ip: maskIp(s.ip) }))
  };
}

@Injectable()
export class AttacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VictoriaLogsService,
    private readonly network: K8sNetworkService,
    private readonly audit: AuditService
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
        projectId: true,
        rateLimit: true,
        project: { select: { organizationId: true } },
        ingresses: { select: { name: true, namespace: true } }
      }
    });
    if (!d?.namespace) throw new NotFoundException('Deployment not found');
    return d;
  }

  async report(
    deploymentId: string,
    opts: { start: number; end: number; canEdit: boolean }
  ): Promise<AttackReport & { rateLimit: RateLimit | null; rateLimitSupported: boolean }> {
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
      counts.map((c) => ({ ip: c.client_ip ?? '', requests: Number(c.requests) || 0 }))
    );
    const report = await this.withFloods(detected, flooding, scope, bucketMs);
    const ingressClasses = await this.ingressClasses(d.ingresses);
    const result = {
      ...report,
      rateLimit: parseRateLimit(d.rateLimit),
      rateLimitSupported: ingressClasses.some((c) => supportsRateLimit(c))
    };
    return opts.canEdit ? result : { ...result, ...maskReport(result) };
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
      topSources: [...sources.values()]
        .filter((s) => s.kinds.length > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      samples: detected.samples.filter((s) => s.kind !== 'flood')
    };
  }

  private async ingressClasses(ingresses: { name: string; namespace: string }[]) {
    const objects = await this.prisma.k8sObject.findMany({
      where: {
        kind: 'Ingress',
        OR: ingresses.map((i) => ({ namespace: i.namespace, name: i.name }))
      },
      select: { name: true, namespace: true, manifest: true }
    });
    return objects.map(
      (o) =>
        (o.manifest as { spec?: { ingressClassName?: string } })?.spec?.ingressClassName ?? null
    );
  }

  async setRateLimit(
    deploymentId: string,
    limit: RateLimit | null,
    userId: string
  ): Promise<{ rateLimit: RateLimit | null; applied: number; unsupported: number }> {
    const d = await this.target(deploymentId);
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { rateLimit: limit ? (limit as unknown as Prisma.InputJsonValue) : Prisma.DbNull }
    });
    const objects = d.ingresses.length
      ? await this.prisma.k8sObject.findMany({
          where: {
            kind: 'Ingress',
            OR: d.ingresses.map((i) => ({ namespace: i.namespace, name: i.name }))
          },
          select: { name: true, namespace: true, manifest: true }
        })
      : [];
    let applied = 0;
    let unsupported = 0;
    for (const o of objects) {
      const manifest = o.manifest as {
        metadata?: { annotations?: Record<string, string> };
        spec?: { ingressClassName?: string };
      };
      const cls = manifest?.spec?.ingressClassName ?? null;
      if (!supportsRateLimit(cls)) {
        unsupported++;
        continue;
      }
      const patch = rateLimitPatch(manifest?.metadata?.annotations, cls, limit);
      if (patch) await this.network.patchIngressAnnotations(o.namespace, o.name, patch);
      applied++;
    }
    void this.audit.log({
      action: 'deployment.rate_limit.updated',
      actorUserId: userId,
      organizationId: d.project.organizationId,
      projectId: d.projectId,
      deploymentId: d.id,
      targetType: 'deployment',
      targetId: d.id,
      targetLabel: d.name,
      metadata: {
        requests: [parseRateLimit(d.rateLimit)?.requests ?? null, limit?.requests ?? null],
        periodSeconds: limit?.periodSeconds ?? null
      }
    });
    return { rateLimit: limit, applied, unsupported };
  }
}
