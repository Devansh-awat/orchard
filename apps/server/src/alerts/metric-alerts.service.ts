import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { VictoriaMetricsService } from '../metrics/victoria-metrics.service';
import { ObservabilityService } from '../observability/observability.service';
import type { IngressQueries } from '../metrics/ingress';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { scopeChain, type ResolvedScope } from '../notifications/notification-scope';
import { LeaderElectionService } from '../events/leader-election.service';
import { OrgEventsService } from '../events/org-events.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_MIN_REQUEST_RATE,
  MAX_FOR_SECONDS,
  METRIC_CATALOGUE,
  MIN_FOR_SECONDS,
  breaches,
  buildMetricQuery,
  decide,
  describeRule,
  formatValue,
  metricDef,
  recoverSecondsFor,
  RATE_WINDOW,
  sampleHasData,
  type AlertClock,
  type Comparator,
  type MetricId,
  type MetricTarget,
  type Sample
} from './metric-catalogue';

export interface AlertRuleInput {
  scopeType?: string;
  scopeId?: string | null;
  metric?: string;
  comparator?: string;
  threshold?: number;
  forSeconds?: number;
  minRequestRate?: number | null;
  enabled?: boolean;
}

interface Actor {
  id: string;
  email?: string | null;
}

interface RuleRow {
  id: string;
  organizationId: string;
  scopeType: string;
  scopeId: string | null;
  metric: string;
  comparator: string;
  threshold: number;
  forSeconds: number;
  minRequestRate: number | null;
}

interface TargetRow {
  id: string;
  name: string;
  displayName: string | null;
  namespace: string;
  replicas: number;
  createdBy: string | null;
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | null;
  project: {
    id: string;
    name: string;
    organizationId: string;
    organization: {
      slug: string;
      defaultPodCpuMilli: number | null;
      defaultPodMemoryBytes: bigint | null;
    };
  };
}

const EVALUATE_EVERY_MS = 30_000;
const MAX_RULES_PER_PASS = 300;
const MAX_TARGETS_PER_RULE = 200;
const MAX_EVALUATIONS_PER_PASS = 600;
const MAX_RULES_PER_SCOPE = 25;
const FALLBACK_CPU_MILLI = 100;
const FALLBACK_MEMORY_BYTES = 128 * 1024 * 1024;
const ALERT_SCOPES = new Set(['org', 'project', 'deployment']);
// A rule whose app or project is gone has no project to ask about, so removing
// it falls to an org admin or whoever wrote it.
const ORPHAN_RULE_SCOPE: ResolvedScope = {
  scopeType: 'org',
  scopeId: null,
  projectId: null,
  label: 'Organization'
};

@Injectable()
export class MetricAlertsService {
  private readonly logger = new Logger(MetricAlertsService.name);

  private running = false;

  private readonly frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4000').replace(
    /\/$/,
    ''
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly vm: VictoriaMetricsService,
    private readonly observability: ObservabilityService,
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
    private readonly orgEvents: OrgEventsService,
    private readonly audit: AuditService,
    @Optional() private readonly leader?: LeaderElectionService
  ) {}

  catalogue() {
    return METRIC_CATALOGUE.map((m) => ({
      id: m.id,
      label: m.label,
      unit: m.unit,
      comparators: m.comparators,
      needsIngress: m.needsIngress,
      requestRateGuard: m.requestRateGuard,
      defaultThreshold: m.defaultThreshold,
      defaultForSeconds: m.defaultForSeconds,
      maxThreshold: m.maxThreshold ?? null
    }));
  }

  async listRules(
    organizationId: string,
    scopeType?: string,
    scopeId?: string | null,
    visibleProjectIds: string[] | null = null
  ) {
    if (!scopeType) {
      const all = await this.prisma.metricAlertRule.findMany({
        where: { organizationId },
        orderBy: [{ scopeType: 'asc' }, { createdAt: 'asc' }],
        include: { _count: { select: { states: true } } }
      });
      const rows = await this.onlyVisible(all, visibleProjectIds);
      return rows.map((r) => this.presentRule(r, false));
    }
    const scope = await this.resolveAlertScope(organizationId, scopeType, scopeId ?? null);
    if (visibleProjectIds && scope.projectId && !visibleProjectIds.includes(scope.projectId)) {
      throw new NotFoundException('Scope not found');
    }
    const chain = scopeChain(scope);
    const rows = await this.prisma.metricAlertRule.findMany({
      where: {
        organizationId,
        OR: chain.map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId }))
      },
      orderBy: [{ createdAt: 'asc' }],
      include: { _count: { select: { states: true } } }
    });
    return rows.map((r) =>
      this.presentRule(r, !(r.scopeType === scope.scopeType && r.scopeId === scope.scopeId))
    );
  }

  async createRule(organizationId: string, input: AlertRuleInput, actor: Actor) {
    const scope = await this.resolveAlertScope(
      organizationId,
      input.scopeType,
      input.scopeId ?? null
    );
    await this.rules.assertCanEditScope(organizationId, scope, actor);
    const data = this.validate(input, null);
    const count = await this.prisma.metricAlertRule.count({
      where: { organizationId, scopeType: scope.scopeType, scopeId: scope.scopeId }
    });
    if (count >= MAX_RULES_PER_SCOPE) {
      throw new BadRequestException(`A scope is limited to ${MAX_RULES_PER_SCOPE} alert rules`);
    }
    const rule = await this.prisma.metricAlertRule.create({
      data: {
        organizationId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ...data,
        enabled: input.enabled !== false,
        createdById: actor.id
      },
      include: { _count: { select: { states: true } } }
    });
    void this.audit.log({
      action: 'alert_rule.created',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      projectId: scope.projectId ?? undefined,
      deploymentId: scope.scopeType === 'deployment' ? scope.scopeId : undefined,
      targetType: 'alert_rule',
      targetId: rule.id,
      targetLabel: describeRule(rule),
      metadata: { scope: scope.label }
    });
    return this.presentRule(rule, false);
  }

  async updateRule(organizationId: string, ruleId: string, input: AlertRuleInput, actor: Actor) {
    const existing = await this.prisma.metricAlertRule.findFirst({
      where: { id: ruleId, organizationId }
    });
    if (!existing) throw new NotFoundException('Alert rule not found');
    const scope = await this.resolveAlertScope(
      organizationId,
      existing.scopeType,
      existing.scopeId
    );
    await this.rules.assertCanEditScope(organizationId, scope, actor);
    const data = this.validate(
      {
        metric: input.metric ?? existing.metric,
        comparator: input.comparator ?? existing.comparator,
        threshold: input.threshold ?? existing.threshold,
        forSeconds: input.forSeconds ?? existing.forSeconds,
        minRequestRate:
          input.minRequestRate === undefined ? existing.minRequestRate : input.minRequestRate
      },
      existing
    );
    const changedShape =
      data.metric !== existing.metric ||
      data.comparator !== existing.comparator ||
      data.threshold !== existing.threshold;
    const rule = await this.prisma.$transaction(async (tx) => {
      if (changedShape || input.enabled === false) {
        await tx.metricAlertState.deleteMany({ where: { ruleId } });
      }
      return tx.metricAlertRule.update({
        where: { id: ruleId },
        data: { ...data, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) },
        include: { _count: { select: { states: true } } }
      });
    });
    void this.audit.log({
      action: 'alert_rule.updated',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      projectId: scope.projectId ?? undefined,
      deploymentId: scope.scopeType === 'deployment' ? scope.scopeId : undefined,
      targetType: 'alert_rule',
      targetId: rule.id,
      targetLabel: describeRule(rule),
      metadata: this.audit.diff(existing, rule, [
        'metric',
        'comparator',
        'threshold',
        'forSeconds',
        'minRequestRate',
        'enabled'
      ])
    });
    return this.presentRule(rule, false);
  }

  async deleteRule(organizationId: string, ruleId: string, actor: Actor) {
    const existing = await this.prisma.metricAlertRule.findFirst({
      where: { id: ruleId, organizationId }
    });
    if (!existing) throw new NotFoundException('Alert rule not found');
    const scope = await this.resolveAlertScope(
      organizationId,
      existing.scopeType,
      existing.scopeId
    ).catch((err) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });
    if (scope) {
      await this.rules.assertCanEditScope(organizationId, scope, actor);
    } else if (existing.createdById !== actor.id) {
      await this.rules.assertCanEditScope(organizationId, ORPHAN_RULE_SCOPE, actor);
    }
    await this.prisma.metricAlertRule.delete({ where: { id: ruleId } });
    void this.audit.log({
      action: 'alert_rule.deleted',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      projectId: scope?.projectId ?? undefined,
      deploymentId: scope?.scopeType === 'deployment' ? (scope.scopeId ?? undefined) : undefined,
      targetType: 'alert_rule',
      targetId: ruleId,
      targetLabel: describeRule(existing)
    });
    return { ok: true };
  }

  /** Every rule that applies to one deployment, with its live state if any. */
  async statesFor(organizationId: string, deploymentId: string) {
    const rules = await this.listRules(organizationId, 'deployment', deploymentId);
    const states = await this.prisma.metricAlertState.findMany({
      where: { targetId: deploymentId, ruleId: { in: rules.map((r) => r.id) } }
    });
    const byRule = new Map(states.map((s) => [s.ruleId, s]));
    const quiet = rules.filter((rule) => rule.enabled && !byRule.has(rule.id));
    const withData = new Set(
      (
        await Promise.all(
          quiet.map(async (rule) =>
            (await this.hasData({ ...rule, organizationId }, deploymentId).catch(() => false))
              ? rule.id
              : null
          )
        )
      ).filter(Boolean)
    );
    return rules.map((rule) => {
      const state = byRule.get(rule.id);
      const status = !rule.enabled
        ? 'off'
        : !state
          ? withData.has(rule.id)
            ? 'ok'
            : 'unknown'
          : state.unknownSince
            ? 'unknown'
            : state.notifiedAt
              ? state.okSince
                ? 'recovering'
                : 'firing'
              : 'pending';
      return {
        ruleId: rule.id,
        metric: rule.metric,
        label: rule.description,
        inherited: rule.inherited,
        status,
        value: state?.lastValue ?? null,
        valueLabel:
          state?.lastValue != null ? formatValue(rule.metric as MetricId, state.lastValue) : null,
        since: state?.firingSince?.toISOString() ?? null,
        notifiedAt: state?.notifiedAt?.toISOString() ?? null,
        lastEvaluatedAt: state?.lastEvaluatedAt?.toISOString() ?? null
      };
    });
  }

  private async hasData(rule: RuleRow, deploymentId: string): Promise<boolean> {
    const def = metricDef(rule.metric);
    if (!def) return false;
    const [target] = await this.targetsFor({
      ...rule,
      scopeType: 'deployment',
      scopeId: deploymentId
    });
    if (!target) return false;
    const selector = def.needsIngress ? await this.observability.ingressFor(target.id) : null;
    const ctx = this.metricTarget(target, selector);
    const query = buildMetricQuery(def.id, ctx);
    if (query.kind === 'inapplicable') return false;
    return sampleHasData(await this.sample(rule, def.id, query.promql, ctx));
  }

  private metricTarget(target: TargetRow, ingress: IngressQueries | null): MetricTarget {
    return {
      namespace: target.namespace,
      name: target.name,
      replicas: target.replicas,
      cpuLimitMilli:
        target.cpuRequestMilli ??
        target.project.organization.defaultPodCpuMilli ??
        FALLBACK_CPU_MILLI,
      memoryLimitBytes: Number(
        target.memoryRequestBytes ??
          target.project.organization.defaultPodMemoryBytes ??
          FALLBACK_MEMORY_BYTES
      ),
      ingress
    };
  }

  @Interval(EVALUATE_EVERY_MS)
  async evaluate(): Promise<void> {
    if (this.running || !(this.leader?.isLeader() ?? false)) return;
    this.running = true;
    try {
      const rules = await this.prisma.metricAlertRule.findMany({
        where: { enabled: true },
        take: MAX_RULES_PER_PASS,
        orderBy: { createdAt: 'asc' }
      });
      let budget = MAX_EVALUATIONS_PER_PASS;
      const selectorCache = new Map<string, IngressQueries | null>();
      for (const rule of rules) {
        if (budget <= 0) {
          this.logger.warn(
            'alert pass hit the evaluation cap; remaining rules wait for the next pass'
          );
          break;
        }
        try {
          budget -= await this.evaluateRule(rule, selectorCache, budget);
        } catch (err) {
          this.logger.warn(`alert rule ${rule.id} failed: ${(err as Error)?.message ?? err}`);
        }
      }
    } catch (err) {
      this.logger.warn(`alert pass failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  private async evaluateRule(
    rule: RuleRow,
    selectorCache: Map<string, IngressQueries | null>,
    budget: number
  ): Promise<number> {
    const def = metricDef(rule.metric);
    if (!def) return 0;
    const targets = await this.targetsFor(rule);
    const targetIds = new Set(targets.map((t) => t.id));
    await this.prisma.metricAlertState.deleteMany({
      where: { ruleId: rule.id, targetId: { notIn: [...targetIds] } }
    });
    let used = 0;
    const now = new Date();
    for (const target of targets) {
      if (used >= budget) break;
      let selector = selectorCache.get(target.id);
      if (selector === undefined) {
        selector = def.needsIngress ? await this.observability.ingressFor(target.id) : null;
        selectorCache.set(target.id, selector);
      }
      const ctx = this.metricTarget(target, selector);
      const query = buildMetricQuery(def.id, ctx);
      if (query.kind === 'inapplicable') continue;
      used += 1;
      const sample = await this.sample(rule, def.id, query.promql, ctx);
      await this.apply(rule, target, sample, now);
    }
    return used;
  }

  private async sample(
    rule: RuleRow,
    metric: MetricId,
    promql: string,
    ctx: MetricTarget
  ): Promise<Sample> {
    const def = metricDef(metric)!;
    if (def.requestRateGuard && ctx.ingress) {
      const rate = await this.vm.queryInstantStrict(ctx.ingress.requestRate(RATE_WINDOW));
      if (rate.ok === false) return { kind: 'unknown', reason: rate.reason };
      const floor = rule.minRequestRate ?? DEFAULT_MIN_REQUEST_RATE;
      if ((rate.value ?? 0) < floor) return { kind: 'ok', value: null, empty: true };
    }
    const result = await this.vm.queryInstantStrict(promql);
    if (result.ok === false) return { kind: 'unknown', reason: result.reason };
    if (result.value === null) return { kind: 'ok', value: null, empty: true };
    return breaches(rule.comparator as Comparator, result.value, rule.threshold)
      ? { kind: 'breaching', value: result.value }
      : { kind: 'ok', value: result.value };
  }

  private async apply(rule: RuleRow, target: TargetRow, sample: Sample, now: Date) {
    const where = { ruleId_targetId: { ruleId: rule.id, targetId: target.id } };
    const current = await this.prisma.metricAlertState.findUnique({ where });
    const clock: AlertClock | null = current
      ? {
          firingSince: current.firingSince,
          okSince: current.okSince,
          notifiedAt: current.notifiedAt,
          unknownSince: current.unknownSince
        }
      : null;
    const decision = decide(clock, sample, now, {
      forSeconds: rule.forSeconds,
      recoverSeconds: recoverSecondsFor(rule.forSeconds)
    });
    const lastValue = sample.kind === 'unknown' ? (current?.lastValue ?? null) : sample.value;

    if (decision.next === null) {
      if (!current) return;
      if (decision.action === 'resolve') {
        const claimed = await this.prisma.metricAlertState.deleteMany({
          where: { id: current.id, notifiedAt: { not: null } }
        });
        if (claimed.count > 0) await this.announce(rule, target, current.id, 'resolved', lastValue);
      } else {
        await this.prisma.metricAlertState.deleteMany({
          where: { id: current.id, notifiedAt: null }
        });
      }
      return;
    }

    const next = decision.next;
    const data = {
      firingSince: next.firingSince,
      okSince: next.okSince,
      unknownSince: next.unknownSince,
      lastValue,
      lastEvaluatedAt: now
    };
    const row = current
      ? await this.prisma.metricAlertState.update({ where: { id: current.id }, data })
      : await this.prisma.metricAlertState.create({
          data: { ruleId: rule.id, targetId: target.id, ...data }
        });

    if (decision.action === 'fire') {
      const claimed = await this.prisma.metricAlertState.updateMany({
        where: { id: row.id, notifiedAt: null },
        data: { notifiedAt: now }
      });
      if (claimed.count > 0) await this.announce(rule, target, row.id, 'firing', lastValue);
    }
  }

  private async announce(
    rule: RuleRow,
    target: TargetRow,
    episodeId: string,
    kind: 'firing' | 'resolved',
    value: number | null
  ) {
    const label = target.displayName || target.name;
    const def = metricDef(rule.metric);
    const metricLabel = def?.label ?? rule.metric;
    const description = describeRule(rule);
    const now = value != null && def ? formatValue(def.id, value) : null;
    const threshold = def ? formatValue(def.id, rule.threshold) : String(rule.threshold);
    const url = `${this.frontendUrl}/${target.project.organization.slug}/deployments/${target.id}`;
    await this.notifications.notify(
      target.project.organizationId,
      {
        event: kind === 'firing' ? 'alert.firing' : 'alert.resolved',
        title:
          kind === 'firing'
            ? `Alert: ${label} ${description}`
            : `Resolved: ${label} ${description}`,
        body:
          kind === 'firing'
            ? `${metricLabel} on ${label} in ${target.project.name} is ${now ?? 'over the threshold'} (threshold ${threshold}).`
            : `${metricLabel} on ${label} in ${target.project.name} is back within ${threshold}${now ? ` (now ${now})` : ''}.`,
        url,
        projectId: target.project.id,
        projectName: target.project.name,
        targetId: episodeId,
        targetName: label,
        fields: [
          { name: 'Rule', value: description },
          ...(now ? [{ name: 'Now', value: now }] : [])
        ]
      },
      {
        scopeId: target.id,
        actorUserId: target.createdBy,
        dedupeKey: `alert:${rule.id}:${episodeId}:${kind}`
      }
    );
    this.orgEvents.emit({
      organizationId: target.project.organizationId,
      type: 'deployment.changed',
      id: target.id,
      projectId: target.project.id,
      payload: { alert: { ruleId: rule.id, kind } }
    });
  }

  private async targetsFor(rule: RuleRow): Promise<TargetRow[]> {
    const where =
      rule.scopeType === 'deployment'
        ? { id: rule.scopeId ?? '' }
        : rule.scopeType === 'project'
          ? { projectId: rule.scopeId ?? '' }
          : { project: { organizationId: rule.organizationId } };
    const live = await this.prisma.k8sWorkload.findMany({
      where: { readyReplicas: { gt: 0 } },
      select: { deploymentId: true }
    });
    return this.prisma.deployment.findMany({
      where: {
        ...where,
        stopped: false,
        OR: [{ id: { in: live.map((w) => w.deploymentId) } }, { status: 'running' }]
      },
      take: MAX_TARGETS_PER_RULE,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        displayName: true,
        namespace: true,
        replicas: true,
        createdBy: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: {
              select: { slug: true, defaultPodCpuMilli: true, defaultPodMemoryBytes: true }
            }
          }
        }
      }
    });
  }

  private async onlyVisible<T extends { scopeType: string; scopeId: string | null }>(
    rows: T[],
    visibleProjectIds: string[] | null
  ): Promise<T[]> {
    if (visibleProjectIds === null) return rows;
    const visible = new Set(visibleProjectIds);
    const ids = (type: string) =>
      rows.filter((r) => r.scopeType === type && r.scopeId).map((r) => r.scopeId as string);
    const [deployments, databases] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { id: { in: ids('deployment') } },
        select: { id: true, projectId: true }
      }),
      this.prisma.database.findMany({
        where: { id: { in: ids('database') } },
        select: { id: true, projectId: true }
      })
    ]);
    const projectOf = new Map<string, string>();
    for (const d of deployments) projectOf.set(d.id, d.projectId);
    for (const d of databases) projectOf.set(d.id, d.projectId);
    return rows.filter((r) => {
      if (r.scopeType === 'org') return true;
      if (r.scopeType === 'project') return visible.has(r.scopeId ?? '');
      const projectId = projectOf.get(r.scopeId ?? '');
      return projectId !== undefined && visible.has(projectId);
    });
  }

  private async resolveAlertScope(
    organizationId: string,
    scopeType: string | undefined,
    scopeId: string | null
  ): Promise<ResolvedScope> {
    if (!scopeType || !ALERT_SCOPES.has(scopeType)) {
      throw new BadRequestException('Alert rules apply to an organization, a project, or an app');
    }
    return this.rules.resolveScope(organizationId, scopeType, scopeId);
  }

  private validate(input: AlertRuleInput, existing: RuleRow | null) {
    const def = metricDef(input.metric ?? '');
    if (!def) {
      throw new BadRequestException(
        `Metric must be one of: ${METRIC_CATALOGUE.map((m) => m.id).join(', ')}`
      );
    }
    const comparator = (input.comparator ?? def.comparators[0]) as Comparator;
    if (!def.comparators.includes(comparator)) {
      throw new BadRequestException(
        `${def.label} can only be compared with ${def.comparators.join(' or ')}`
      );
    }
    const threshold = Number(input.threshold ?? existing?.threshold ?? def.defaultThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new BadRequestException('Threshold must be a number of zero or more');
    }
    if (def.maxThreshold !== undefined && threshold > def.maxThreshold) {
      throw new BadRequestException(`${def.label} cannot exceed ${def.maxThreshold}${def.unit}`);
    }
    const forSeconds = Math.round(
      Number(input.forSeconds ?? existing?.forSeconds ?? def.defaultForSeconds)
    );
    if (
      !Number.isFinite(forSeconds) ||
      forSeconds < MIN_FOR_SECONDS ||
      forSeconds > MAX_FOR_SECONDS
    ) {
      throw new BadRequestException(
        `The window must be between ${MIN_FOR_SECONDS} seconds and ${MAX_FOR_SECONDS / 3600} hours`
      );
    }
    let minRequestRate: number | null = null;
    if (def.requestRateGuard) {
      const raw =
        input.minRequestRate === undefined ? existing?.minRequestRate : input.minRequestRate;
      if (raw !== null && raw !== undefined) {
        minRequestRate = Number(raw);
        if (!Number.isFinite(minRequestRate) || minRequestRate < 0) {
          throw new BadRequestException('Minimum request rate must be a number of zero or more');
        }
      }
    }
    return { metric: def.id, comparator, threshold, forSeconds, minRequestRate };
  }

  private presentRule(
    rule: RuleRow & { enabled: boolean; createdAt: Date; _count?: { states: number } },
    inherited: boolean
  ) {
    return {
      id: rule.id,
      scopeType: rule.scopeType,
      scopeId: rule.scopeId,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      forSeconds: rule.forSeconds,
      minRequestRate: rule.minRequestRate,
      enabled: rule.enabled,
      inherited,
      description: describeRule(rule),
      activeEpisodes: rule._count?.states ?? 0,
      createdAt: rule.createdAt.toISOString()
    };
  }
}
