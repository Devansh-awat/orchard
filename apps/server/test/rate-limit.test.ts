import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimit, rateLimitPatch, supportsRateLimit } from '../src/security/rate-limit';
import { floodIps } from '../src/security/attacks.service';
import { buildSuspicious, buildIpSeries } from '../src/logs/logsql';

test('rate limits must be whole and use a known period', () => {
  assert.deepEqual(parseRateLimit({ requests: 100, periodSeconds: 60 }), {
    requests: 100,
    periodSeconds: 60
  });
  assert.equal(parseRateLimit({ requests: 0, periodSeconds: 60 }), null);
  assert.equal(parseRateLimit({ requests: 10.5, periodSeconds: 60 }), null);
  assert.equal(parseRateLimit({ requests: 10, periodSeconds: 7 }), null);
  assert.equal(parseRateLimit(null), null);
});

test('haproxy gets annotations, traefik is not supported yet', () => {
  assert.equal(supportsRateLimit('haproxy'), true);
  assert.equal(supportsRateLimit('traefik'), false);
  assert.equal(supportsRateLimit(null), false);
  assert.deepEqual(rateLimitPatch({}, 'haproxy', { requests: 100, periodSeconds: 60 }), {
    'haproxy.org/rate-limit-requests': '100',
    'haproxy.org/rate-limit-period': '60s'
  });
});

test('a patch is only produced when the ingress drifted', () => {
  const set = { 'haproxy.org/rate-limit-requests': '100', 'haproxy.org/rate-limit-period': '60s' };
  assert.equal(rateLimitPatch(set, 'haproxy', { requests: 100, periodSeconds: 60 }), null);
  assert.deepEqual(rateLimitPatch(set, 'haproxy', null), {
    'haproxy.org/rate-limit-requests': null,
    'haproxy.org/rate-limit-period': null
  });
  assert.equal(rateLimitPatch({}, 'haproxy', null), null);
});

test('floods need 300 requests, ten times the median and five clients', () => {
  const quiet = ['a', 'b', 'c', 'd'].map((ip) => ({ ip, requests: 10 }));
  assert.equal(floodIps([...quiet, { ip: 'x', requests: 5000 }]).get('x'), 5000);
  assert.equal(floodIps([...quiet.slice(0, 3), { ip: 'x', requests: 5000 }]).size, 0);
  assert.equal(floodIps([...quiet, { ip: 'x', requests: 250 }]).size, 0);
});

test('suspicious and per-ip queries stay scoped and quoted', () => {
  const scope = { namespace: 'ns', app: 'web', start: 0, end: 60_000 };
  const q = buildSuspicious(scope);
  assert.ok(q.startsWith('{namespace="ns",app="web",kind="access"}'));
  assert.match(q, /status:>=400 or path:~"/);
  assert.match(buildIpSeries(scope, ['1.2.3.4"x'], 60_000), /client_ip:in\("1\.2\.3\.4\\"x"\)/);
});
