import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from '../projects/deployments.service';
import { RightsizingService } from '../rightsizing/rightsizing.service';
import { MetricsService } from '../metrics/metrics.service';
import { ObservabilityService } from '../observability/observability.service';
import { FindingsService } from '../observability/findings.service';
import { ErrorIngestService } from '../observability/error-ingest.service';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { SecurityService } from '../security/security.service';
import { AttacksService } from '../security/attacks.service';
import { computeHealth } from '../health/health.generated';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MOMENT_MS = 15 * 60 * 1000;

const SYMPTOM_PANELS: Record<string, string> = {
  'error-rate': 'panel-error-rate',
  p95: 'panel-response-time',
  'memory-step': 'panel-memory',
  'memory-forecast': 'panel-memory',
  throttling: 'panel-cpu-throttling',
  'restart-burst': 'panel-restarts-and-out-of-memory-kills'
};

export function momentUrl(
  base: string,
  opts: { at: number; panel?: string | null; view?: string; now?: number }
): string {
  const url = new URL(base);
  const now = opts.now ?? Date.now();
  url.searchParams.set('tab', 'observe');
  if (opts.view && opts.view !== 'metrics') url.searchParams.set('view', opts.view);
  url.searchParams.set('from', String(Math.round(opts.at - MOMENT_MS)));
  url.searchParams.set('to', String(Math.round(Math.min(now, opts.at + MOMENT_MS))));
  url.searchParams.set('at', String(Math.round(opts.at)));
  if (opts.panel) url.searchParams.set('panel', opts.panel);
  return url.toString();
}

const last = (points: { x: number; y: number }[] | undefined) =>
  points && points.length ? points[points.length - 1].y : null;
const round = (v: number | null, digits = 1) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;

@Injectable()
export class DiagnosisService {
  private readonly frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly rightsizing: RightsizingService,
    private readonly metrics: MetricsService,
    private readonly observability: ObservabilityService,
    private readonly findings: FindingsService,
    private readonly errors: ErrorIngestService,
    private readonly anomalies: AnomaliesService,
    private readonly security: SecurityService,
    private readonly attacks: AttacksService
  ) {}

  async diagnose(
    deploymentId: string,
    opts: { userId: string; canEdit: boolean; tz?: string | null }
  ) {
    const now = Date.now();
    const failures: Record<string, string> = {};
    const part = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        failures[name] = err instanceof Error ? err.message : String(err);
        return null;
      }
    };

    const deployment: any = await this.deployments.getDeployment(
      deploymentId,
      opts.canEdit,
      opts.userId
    );
    const org = await this.prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { organization: { select: { slug: true } } }
    });
    const appUrl = `${this.frontendUrl}/${org?.organization.slug ?? ''}/deployments/${deploymentId}`;

    const health = computeHealth({
      pods: deployment.pods ?? [],
      rollout: deployment.rollout ?? null,
      replicas: deployment.replicas ?? 0,
      stopped: !!deployment.stopped,
      buildStatus: deployment.buildStatus ?? null,
      strategy: deployment.deployStrategy ?? null,
      now
    });

    const args = {
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      startMs: now - HOUR_MS,
      endMs: now,
      stepMs: 5 * 60_000
    };

    const [found, anomalies, http, throttle, forecast, rightsizing, scan, attacks, topErrors] =
      await Promise.all([
        part('findings', () =>
          this.findings.findings(deploymentId, {
            start: now - DAY_MS,
            end: now,
            tz: opts.tz,
            canEdit: opts.canEdit
          })
        ),
        part('anomalies', () => this.anomalies.forDeployment(deploymentId, opts.canEdit)),
        part('http', () =>
          this.observability.getHttpMetrics(deploymentId, now - HOUR_MS, now, 5 * 60_000)
        ),
        part('throttle', () => this.metrics.fetchDeploymentThrottle(args)),
        part('forecast', () =>
          this.metrics.forecastDeploymentMemory({
            id: deploymentId,
            name: deployment.name,
            namespace: deployment.namespace,
            memoryRequestBytes:
              deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null
          })
        ),
        part('rightsizing', () => this.rightsizing.recommend(deploymentId)),
        part('security', () => this.security.report(deploymentId, opts.canEdit)),
        this.attacks.available
          ? part('attacks', () =>
              this.attacks.report(deploymentId, {
                start: now - DAY_MS,
                end: now,
                canEdit: opts.canEdit
              })
            )
          : Promise.resolve(null),
        opts.canEdit
          ? part('topErrors', () => this.errors.listGroups(deploymentId, 24 * 60))
          : Promise.resolve(null)
      ]);

    const routes = (http?.routes ?? []) as {
      label: string;
      requestRate: number;
      errorPercent: number | null;
      latencyMs: number | null;
    }[];
    const worstRoutes = [...routes]
      .sort(
        (a, b) =>
          (b.errorPercent ?? 0) - (a.errorPercent ?? 0) || (b.latencyMs ?? 0) - (a.latencyMs ?? 0)
      )
      .slice(0, 5)
      .map((r) => ({
        route: r.label,
        rps: round(r.requestRate, 2),
        errorPercent: round(r.errorPercent, 2),
        latencyMs: round(r.latencyMs, 0)
      }));

    return {
      app: {
        id: deploymentId,
        name: deployment.name,
        image: deployment.image ?? null,
        url: appUrl
      },
      health: {
        app: health.app,
        deploy: health.deploy,
        build: health.build,
        serving: health.serving,
        desired: health.desired,
        problems: health.problems.map((p) => ({
          scope: p.scope,
          tone: p.tone,
          title: p.title,
          hint: p.hint,
          pods: p.pods
        }))
      },
      rollout: deployment.rollout
        ? { state: deployment.rollout.state, reason: deployment.rollout.reason }
        : null,
      verdict: deployment.latestVerdict
        ? {
            status: deployment.latestVerdict.status,
            summary: deployment.latestVerdict.summary,
            at: deployment.latestVerdict.at
          }
        : null,
      anomalies: (anomalies ?? []).slice(0, 10).map((a) => ({
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        since: a.since
      })),
      findings: (found?.findings ?? []).map((f) => ({
        kind: f.kind,
        sentence: f.sentence,
        at: new Date(f.at).toISOString(),
        cause: f.causeId,
        link: momentUrl(appUrl, { at: f.at, panel: SYMPTOM_PANELS[f.kind], now })
      })),
      changes: (found?.changes ?? []).slice(-30).map((c) => ({
        at: new Date(c.t).toISOString(),
        kind: c.kind,
        label: c.label,
        detail: c.detail,
        actor: c.actor?.name ?? null
      })),
      resources: {
        cpu: {
          usedMilli: round(deployment.totalCpuUsage ?? null, 0),
          limitMilli: deployment.cpuRequestMilli ?? null,
          throttledPercent: round(last(throttle ?? undefined), 1)
        },
        memory: {
          usedBytes: deployment.totalMemoryUsage ?? null,
          limitBytes:
            deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null,
          forecast: forecast
            ? {
                hitsLimitAt: new Date(forecast.hitsLimitAt).toISOString(),
                slopeBytesPerHour: Math.round(forecast.slopeBytesPerHour),
                confidence: round(forecast.confidence, 2)
              }
            : null
        },
        rightsizing:
          rightsizing && rightsizing.status === 'ok'
            ? {
                confidence: rightsizing.confidence,
                memory: {
                  change: rightsizing.memory.change,
                  recommendedBytes: rightsizing.memory.recommended,
                  reason: rightsizing.memory.reason
                },
                cpu: {
                  change: rightsizing.cpu.change,
                  recommendedMilli: rightsizing.cpu.recommended,
                  reason: rightsizing.cpu.reason
                }
              }
            : rightsizing
              ? { confidence: null, reason: rightsizing.reason }
              : null
      },
      http: http?.source
        ? {
            ingress: http.source,
            rps: round(last(http.requestRate), 2),
            errorPercent: round(last(http.errorRate), 2),
            p95Ms: round(last(http.latency?.p95), 0),
            averageMs: round(last(http.latencyAvg), 0),
            worstRoutes
          }
        : null,
      security: {
        worstCve: scan?.scan?.severity ?? null,
        counts: scan?.scan?.counts ?? null,
        attacks: attacks
          ? {
              last24h: attacks.byKind,
              rateLimit: attacks.rateLimit,
              topSources: attacks.topSources.slice(0, 5)
            }
          : null
      },
      topErrors: topErrors
        ? topErrors.errors.slice(0, 5).map((e) => ({
            type: e.type,
            message: e.message.slice(0, 300),
            count: e.count,
            lastSeen: e.lastSeen,
            status: e.status
          }))
        : null,
      links: {
        app: appUrl,
        observe: `${appUrl}?tab=observe`,
        logs: `${appUrl}?tab=observe&view=logs`
      },
      unavailable: Object.keys(failures).length ? failures : undefined
    };
  }
}
