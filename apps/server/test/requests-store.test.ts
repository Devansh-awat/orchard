import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLatency, toRequest, toRouteStats } from '../src/logs/requests.service';

test('route stats become rates, error shares and real percentiles', () => {
  const [route] = toRouteStats(
    [
      {
        host: 'api.example.com',
        route: '/users/:id',
        requests: '600',
        errors: '6',
        p50: '20',
        p95: '180',
        p99: '420'
      }
    ],
    'api',
    60
  );
  assert.equal(route.label, 'api.example.com/users/:id');
  assert.equal(route.requestRate, 10);
  assert.equal(route.errorPercent, 1);
  assert.equal(route.latencyMs, 180);
  assert.equal(route.p99, 420);
});

test('routes with no requests are dropped', () => {
  assert.deepEqual(toRouteStats([{ host: 'a', route: '/', requests: '0' }], 'api', 60), []);
});

test('latency rows become three series and skip broken times', () => {
  const series = toLatency([
    { _time: '2026-10-28T10:00:00Z', p50: '10', p95: '90', p99: '200' },
    { _time: 'nope', p50: '1', p95: '1', p99: '1' },
    { _time: '2026-10-28T10:05:00Z', p50: '12', p95: '', p99: '210' }
  ]);
  assert.equal(series.p50.length, 2);
  assert.equal(series.p95.length, 1);
  assert.equal(series.p99[1].y, 210);
});

test('access rows map onto a typed request', () => {
  const r = toRequest({
    _time: '2026-10-28T10:00:00Z',
    method: 'GET',
    host: 'api.example.com',
    path: '/users/42',
    route: '/users/:id',
    status: '503',
    duration_ms: '29',
    client_ip: '203.0.113.9',
    user_agent: 'curl/8'
  });
  assert.equal(r.status, 503);
  assert.equal(r.durationMs, 29);
  assert.equal(r.bytes, null);
  assert.equal(r.route, '/users/:id');
});
