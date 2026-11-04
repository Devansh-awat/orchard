import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  METRIC_IDS,
  breaches,
  buildMetricQuery,
  decide,
  describeRule,
  formatValue,
  recoverSecondsFor,
  sampleHasData,
  type AlertClock,
  type MetricTarget
} from '../src/alerts/metric-catalogue';
import { MetricAlertsService } from '../src/alerts/metric-alerts.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { haproxy } from '../src/metrics/ingress/haproxy';
import { traefik } from '../src/metrics/ingress/traefik';

const target: MetricTarget = {
  namespace: 'proj-ns',
  name: 'crescent',
  replicas: 2,
  cpuLimitMilli: 500,
  memoryLimitBytes: 256 * 1024 * 1024,
  ingress: haproxy.queries({ namespace: 'proj-ns', services: ['crescent'] })
};

const at = (iso: string) => new Date(iso);
const T0 = at('2026-09-25T10:00:00Z');
const plus = (sec: number) => new Date(T0.getTime() + sec * 1000);
const windows = { forSeconds: 300, recoverSeconds: 120 };

test("cpu and memory are a percent of the limit across every replica, and only the deployment's own pods", () => {
  const cpu = buildMetricQuery('cpu_percent', target);
  assert.equal(cpu.kind, 'query');
  assert.match((cpu as any).promql, /\/ 1000$/);
  assert.match(
    (cpu as any).promql,
    /pod=~"\(\?:crescent\|crescent--green\)-\[a-z0-9\]\+-\[a-z0-9\]\+"/
  );
  assert.doesNotMatch((cpu as any).promql, /crescent-\.\*/);
  const mem = buildMetricQuery('memory_percent', target);
  assert.match((mem as any).promql, new RegExp(`/ ${2 * 256 * 1024 * 1024}$`));
});

test('a rule that cannot be asked of a target is inapplicable, never zero', () => {
  const noIngress = { ...target, ingress: null };
  for (const id of ['request_rate', 'error_rate', 'latency_avg_ms', 'latency_max_ms'] as const) {
    assert.equal(buildMetricQuery(id, noIngress).kind, 'inapplicable', id);
  }
  assert.equal(
    buildMetricQuery('cpu_percent', { ...target, cpuLimitMilli: null }).kind,
    'inapplicable'
  );
  assert.equal(
    buildMetricQuery('memory_percent', { ...target, memoryLimitBytes: 0 }).kind,
    'inapplicable'
  );
  for (const id of METRIC_IDS) assert.equal(buildMetricQuery(id, target).kind, 'query', id);
});

test('latency alerts read the load balancer averages and maxima, since no histogram exists', () => {
  assert.match(
    (buildMetricQuery('latency_avg_ms', target) as any).promql,
    /haproxy_backend_response_time_average_seconds.*\* 1000$/
  );
  assert.match(
    (buildMetricQuery('latency_max_ms', target) as any).promql,
    /haproxy_backend_max_response_time_seconds.*\* 1000$/
  );
  assert.match((buildMetricQuery('error_rate', target) as any).promql, /clamp_min/);
});

test('on traefik the same alerts read its own metrics, with p99 as the slowest requests', () => {
  const t = {
    ...target,
    ingress: traefik.queries({ namespace: 'proj-ns', services: ['crescent'] })
  };
  assert.match(
    (buildMetricQuery('request_rate', t) as any).promql,
    /traefik_service_requests_total/
  );
  assert.match((buildMetricQuery('error_rate', t) as any).promql, /code=~"5\.\."/);
  assert.match((buildMetricQuery('latency_max_ms', t) as any).promql, /histogram_quantile\(0\.99/);
});

test('a breach has to hold for the whole window before it fires, and fires once', () => {
  let state: AlertClock | null = null;
  let d = decide(state, { kind: 'breaching', value: 90 }, T0, windows);
  assert.equal(d.action, null);
  assert.equal(d.next?.firingSince?.toISOString(), T0.toISOString());
  state = d.next;
  d = decide(state, { kind: 'breaching', value: 91 }, plus(120), windows);
  assert.equal(d.action, null);
  state = d.next;
  d = decide(state, { kind: 'breaching', value: 92 }, plus(300), windows);
  assert.equal(d.action, 'fire');
  assert.equal(d.next?.notifiedAt?.toISOString(), plus(300).toISOString());
  state = d.next;
  d = decide(state, { kind: 'breaching', value: 95 }, plus(600), windows);
  assert.equal(d.action, null);
  assert.equal(d.next?.notifiedAt?.toISOString(), plus(300).toISOString());
});

test('a blip that clears before it was announced is dropped silently', () => {
  const state = decide(null, { kind: 'breaching', value: 90 }, T0, windows).next;
  let d = decide(state, { kind: 'ok', value: 10 }, plus(60), windows);
  assert.equal(d.action, null);
  assert.ok(d.next?.okSince);
  d = decide(d.next, { kind: 'ok', value: 10 }, plus(60 + 120), windows);
  assert.equal(d.action, 'drop');
  assert.equal(d.next, null);
});

test('re-asserting during recovery resets the recovery clock but keeps the firing clock', () => {
  let state = decide(null, { kind: 'breaching', value: 90 }, T0, windows).next;
  state = decide(state, { kind: 'breaching', value: 90 }, plus(300), windows).next;
  assert.ok(state?.notifiedAt);
  state = decide(state, { kind: 'ok', value: 10 }, plus(360), windows).next;
  assert.ok(state?.okSince);
  const back = decide(state, { kind: 'breaching', value: 90 }, plus(420), windows);
  assert.equal(back.action, null);
  assert.equal(back.next?.okSince, null);
  assert.equal(back.next?.firingSince?.toISOString(), T0.toISOString());
  assert.ok(back.next?.notifiedAt);
});

test('an announced episode resolves only after the condition has cleared for the whole recovery window', () => {
  let state = decide(null, { kind: 'breaching', value: 90 }, T0, windows).next;
  state = decide(state, { kind: 'breaching', value: 90 }, plus(300), windows).next;
  state = decide(state, { kind: 'ok', value: 10 }, plus(360), windows).next;
  let d = decide(state, { kind: 'ok', value: 10 }, plus(360 + 60), windows);
  assert.equal(d.action, null);
  d = decide(d.next, { kind: 'ok', value: 10 }, plus(360 + 120), windows);
  assert.equal(d.action, 'resolve');
  assert.equal(d.next, null);
});

test('the metrics store not answering freezes the clocks instead of resolving the alert', () => {
  let state = decide(null, { kind: 'breaching', value: 90 }, T0, windows).next;
  state = decide(state, { kind: 'breaching', value: 90 }, plus(300), windows).next;
  const gone = decide(state, { kind: 'unknown', reason: 'unreachable' }, plus(400), windows);
  assert.equal(gone.action, null);
  assert.ok(gone.next?.notifiedAt);
  assert.equal(gone.next?.okSince, null);
  assert.equal(gone.next?.unknownSince?.toISOString(), plus(400).toISOString());
  const later = decide(gone.next, { kind: 'unknown', reason: 'unreachable' }, plus(9000), windows);
  assert.equal(later.action, null);
  assert.equal(later.next?.unknownSince?.toISOString(), plus(400).toISOString());
  const back = decide(later.next, { kind: 'breaching', value: 90 }, plus(9100), windows);
  assert.equal(back.next?.unknownSince, null);
  assert.equal(decide(null, { kind: 'unknown', reason: 'x' }, T0, windows).next, null);
});

test('comparators, recovery windows and labels read the way the rule was written', () => {
  assert.equal(breaches('gt', 90, 85), true);
  assert.equal(breaches('gt', 85, 85), false);
  assert.equal(breaches('lt', 0.1, 1), true);
  assert.equal(recoverSecondsFor(60), 120);
  assert.equal(recoverSecondsFor(300), 300);
  assert.equal(recoverSecondsFor(3600), 600);
  assert.equal(formatValue('cpu_percent', 91.26), '91.3%');
  assert.equal(formatValue('latency_avg_ms', 512.4), '512ms');
  assert.equal(formatValue('request_rate', 3.14), '3.1 req/s');
  assert.equal(
    describeRule({ metric: 'error_rate', comparator: 'gt', threshold: 5, forSeconds: 300 }),
    '5xx rate above 5% for 5 min'
  );
  assert.equal(
    describeRule({ metric: 'request_rate', comparator: 'lt', threshold: 1, forSeconds: 600 }),
    'Requests below 1 req/s for 10 min'
  );
});

function statesHarness(opts: { value: number | null; ok?: boolean; running?: boolean }) {
  const service = Object.create(MetricAlertsService.prototype) as any;
  const rule = {
    id: 'r1',
    organizationId: 'org',
    scopeType: 'deployment',
    scopeId: 'd1',
    metric: 'cpu_percent',
    comparator: 'gt',
    threshold: 85,
    forSeconds: 300,
    minRequestRate: null,
    enabled: true,
    description: 'CPU',
    inherited: false
  };
  service.listRules = async () => [rule];
  service.prisma = {
    metricAlertState: { findMany: async () => [] },
    k8sWorkload: { findMany: async () => [] },
    deployment: {
      findMany: async () =>
        opts.running === false
          ? []
          : [
              {
                id: 'd1',
                name: 'web',
                namespace: 'ns',
                replicas: 1,
                cpuRequestMilli: 100,
                memoryRequestBytes: null,
                project: {
                  organization: { defaultPodCpuMilli: null, defaultPodMemoryBytes: null }
                }
              }
            ]
    }
  };
  service.observability = { ingressFor: async () => null };
  service.vm = {
    queryInstantStrict: async () =>
      opts.ok === false ? { ok: false, reason: 'down' } : { ok: true, value: opts.value }
  };
  return service;
}

test('a rule with no state reads OK only when the metric has a value', async () => {
  const status = async (opts: Parameters<typeof statesHarness>[0]) =>
    (await statesHarness(opts).statesFor('org', 'd1'))[0].status;
  assert.equal(await status({ value: 12 }), 'ok');
  assert.equal(await status({ value: null }), 'unknown');
  assert.equal(await status({ value: null, ok: false }), 'unknown');
  assert.equal(await status({ value: 12, running: false }), 'unknown');
});

test('a rule guarded by a request floor reads as no data while the app is quiet', async () => {
  for (const metric of ['latency_avg_ms', 'latency_max_ms', 'error_rate']) {
    const service = statesHarness({ value: 0 });
    const [rule] = await service.listRules();
    service.listRules = async () => [{ ...rule, metric }];
    service.observability = {
      ingressFor: async () => ({
        requestRate: () => 'rate',
        errorPercent: () => 'errors',
        latencyAvgMs: () => 'avg',
        latencyMaxMs: () => 'max'
      })
    };
    const [state] = await service.statesFor('org', 'd1');
    assert.equal(state.status, 'unknown', metric);
    assert.equal(state.value, null, metric);
  }
});

test('a guarded rule with real traffic still reads OK', async () => {
  const service = statesHarness({ value: 5 });
  const [rule] = await service.listRules();
  service.listRules = async () => [{ ...rule, metric: 'latency_avg_ms', threshold: 500 }];
  service.observability = {
    ingressFor: async () => ({ requestRate: () => 'rate', latencyAvgMs: () => 'avg' })
  };
  assert.equal((await service.statesFor('org', 'd1'))[0].status, 'ok');
});

function deleteHarness(opts: { scope: () => Promise<unknown>; createdById?: string }) {
  const service = Object.create(MetricAlertsService.prototype) as any;
  const deleted: string[] = [];
  const checked: unknown[] = [];
  service.prisma = {
    metricAlertRule: {
      findFirst: async () => ({
        id: 'r1',
        scopeType: 'deployment',
        scopeId: 'gone',
        metric: 'cpu_percent',
        comparator: 'gt',
        threshold: 85,
        forSeconds: 300,
        createdById: opts.createdById ?? 'someone'
      }),
      delete: async ({ where }: any) => deleted.push(where.id)
    }
  };
  service.rules = {
    resolveScope: opts.scope,
    assertCanEditScope: async (_org: string, scope: any) => {
      checked.push(scope);
      if (scope.scopeType === 'org') throw new ForbiddenException('admins only');
    }
  };
  service.audit = { log: async () => undefined };
  return { service, deleted, checked };
}

const gone = async () => {
  throw new NotFoundException('Deployment not found');
};

test('a rule on a deleted app can be deleted by an org admin, and only an admin', async () => {
  const denied = deleteHarness({ scope: gone });
  await assert.rejects(
    denied.service.deleteRule('org', 'r1', { id: 'member' }),
    ForbiddenException
  );
  assert.deepEqual(denied.deleted, []);

  const admin = deleteHarness({ scope: gone });
  admin.service.rules.assertCanEditScope = async () => undefined;
  assert.deepEqual(await admin.service.deleteRule('org', 'r1', { id: 'admin' }), { ok: true });
  assert.deepEqual(admin.deleted, ['r1']);
});

test('whoever wrote a rule on a deleted app can delete it', async () => {
  const { service, deleted, checked } = deleteHarness({ scope: gone, createdById: 'author' });
  await service.deleteRule('org', 'r1', { id: 'author' });
  assert.deepEqual(deleted, ['r1']);
  assert.deepEqual(checked, []);
});

test('a failed scope lookup deletes nothing: only a real not-found means gone', async () => {
  const { service, deleted } = deleteHarness({
    scope: async () => {
      throw new Error('database unavailable');
    },
    createdById: 'author'
  });
  await assert.rejects(service.deleteRule('org', 'r1', { id: 'author' }), /database unavailable/);
  assert.deepEqual(deleted, []);
});

test('a rule on a live app still goes through its own scope check', async () => {
  const scope = { scopeType: 'deployment', scopeId: 'd1', projectId: 'p1', label: 'web' };
  const { service, deleted, checked } = deleteHarness({ scope: async () => scope });
  await service.deleteRule('org', 'r1', { id: 'editor' });
  assert.deepEqual(checked, [scope]);
  assert.deepEqual(deleted, ['r1']);
});

test('deleting an app removes the alert rules scoped to it', async () => {
  const where: unknown[] = [];
  const table = { deleteMany: async (args: any) => where.push(args.where) };
  const service = Object.create(NotificationsService.prototype) as any;
  service.prisma = {
    notificationRule: table,
    notificationChannel: table,
    userNotificationSetting: table,
    metricAlertRule: {
      deleteMany: async (args: any) => where.push({ alertRule: args.where })
    }
  };
  await service.purgeScope('deployment', 'd1');
  assert.deepEqual(where.at(-1), { alertRule: { scopeType: 'deployment', scopeId: 'd1' } });
});

test('only an empty sample counts as missing data', () => {
  assert.equal(sampleHasData({ kind: 'ok', value: 0 }), true);
  assert.equal(sampleHasData({ kind: 'ok', value: null, empty: true }), false);
  assert.equal(sampleHasData({ kind: 'unknown', reason: 'down' }), false);
  assert.equal(sampleHasData({ kind: 'breaching', value: 90 }), true);
});
