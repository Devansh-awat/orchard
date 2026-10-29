import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { ObservabilityService } from './observability.service';
import { TimelineService } from './timeline.service';
import { correlate, type Change, type ChangeKind as CauseKind, type Finding } from './correlate';
import { detectSymptoms, type Point } from './symptoms';
import type { ChangeEntry, ChangeKind } from './changes';

const LOOKBACK_MS = 30 * 60_000;
const MIB = 1024 * 1024;

const CAUSE_KINDS: Partial<Record<ChangeKind, CauseKind>> = {
  deploy: 'deploy',
  rollback: 'deploy',
  resources: 'resources',
  env: 'env',
  scale: 'scale',
  config: 'config',
  domain: 'config',
  restart: 'config',
  eviction: 'eviction',
  preemption: 'eviction',
  scheduling: 'platform',
  probe: 'platform',
  volume: 'platform',
  node: 'node'
};

export interface FindingEntry extends Finding {
  kind: string;
}

export function detectionStep(rangeMs: number): number {
  if (rangeMs <= 6 * 60 * 60_000) return 60_000;
  if (rangeMs <= 24 * 60 * 60_000) return 5 * 60_000;
  return 30 * 60_000;
}

export function clockFor(tz: string | null | undefined): (ms: number) => string {
  const zone = tz && validZone(tz) ? tz : null;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zone ?? 'UTC'
  });
  return (ms) => (zone ? fmt.format(ms) : `${fmt.format(ms)} UTC`);
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function toCauses(changes: ChangeEntry[]): Change[] {
  return changes.flatMap((c) => {
    const kind = CAUSE_KINDS[c.kind];
    if (!kind || !c.cause) return [];
    return [
      { id: c.id, t: c.t, kind, label: c.label, phrase: c.cause, actor: c.actor?.name ?? null }
    ];
  });
}

function sumGroups(groups: { points: Point[] }[]): Point[] {
  const acc = new Map<number, number>();
  for (const g of groups) for (const p of g.points) acc.set(p.x, (acc.get(p.x) ?? 0) + p.y);
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

@Injectable()
export class FindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly observability: ObservabilityService,
    private readonly timeline: TimelineService
  ) {}

  async findings(
    deploymentId: string,
    opts: { start: number; end: number; tz?: string | null; canEdit: boolean }
  ): Promise<{ findings: FindingEntry[]; changes: ChangeEntry[] }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });
    if (!deployment?.namespace) return { findings: [], changes: [] };
    const from = opts.start - LOOKBACK_MS;
    const step = detectionStep(opts.end - from);
    const args = {
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      startMs: from,
      endMs: opts.end,
      stepMs: step
    };
    const [http, resources, throttle, health, changes] = await Promise.all([
      this.observability.getHttpMetrics(deploymentId, from, opts.end, step).catch(() => null),
      this.metrics.fetchDeploymentMetrics(args).catch(() => null),
      this.metrics.fetchDeploymentThrottle(args).catch(() => []),
      this.observability.getPodHealth(deploymentId, from, opts.end, step).catch(() => null),
      this.timeline.changes(deploymentId, { start: from, end: opts.end, canEdit: opts.canEdit })
    ]);
    const symptoms = detectSymptoms({
      errorPct: http?.errorRate.map((p) => ({ x: p.x, y: p.y })),
      p95Ms: http?.latency?.p95.map((p) => ({ x: p.x, y: p.y })),
      memoryBytes: resources?.mem.map((p) => ({ x: p.x, y: p.y * MIB })),
      throttledPct: throttle,
      restarts: health?.available ? sumGroups(health.restarts) : []
    }).filter((s) => s.onset >= opts.start);
    const findings = correlate({
      symptoms,
      changes: toCauses(changes.changes),
      formatTime: clockFor(opts.tz)
    });
    const kinds = new Map(symptoms.map((s) => [s.id, s.kind]));
    return {
      findings: findings.map((f) => ({ ...f, kind: kinds.get(f.symptomId) ?? 'unknown' })),
      changes: changes.changes.filter((c) => c.t >= opts.start)
    };
  }
}
