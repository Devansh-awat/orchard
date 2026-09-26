import assert from 'node:assert/strict';
import test from 'node:test';
import {
  METRIC_IDS,
  breaches,
  buildMetricQuery,
  decide,
  describeRule,
  formatValue,
  recoverSecondsFor,
  type AlertClock,
  type MetricTarget
} from '../src/alerts/metric-catalogue';

const target: MetricTarget = {
  namespace: 'proj-ns',
  name: 'crescent',
  replicas: 2,
  cpuLimitMilli: 500,
  memoryLimitBytes: 256 * 1024 * 1024,
  haproxySelector: 'proxy=~"proj-ns_svc_(crescent)_.+"'
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
  const noIngress = { ...target, haproxySelector: null };
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
