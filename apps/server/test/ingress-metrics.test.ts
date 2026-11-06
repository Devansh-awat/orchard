import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INGRESS_ADAPTERS,
  configuredAdapter,
  guessedAdapter,
  ingressQueries,
  ingressScopeMatchers
} from '../src/metrics/ingress';

const target = { namespace: 'ysws-flavortown', services: ['web', 'orchard-protection-proxy'] };

test('ingress queries only read series from the platform scrape job', () => {
  for (const id of ['traefik', 'haproxy']) {
    const q = ingressQueries(id, target)!;
    assert.match(q.requestRate('2m'), id === 'traefik' ? /job="traefik"/ : /job="haproxy-ingress"/);
    assert.match(q.presence, /job="/);
  }
});

test('ingress scope honours job and namespace overrides', () => {
  const env = {
    INGRESS_METRICS_TRAEFIK_JOB: 'my-traefik',
    INGRESS_METRICS_TRAEFIK_NAMESPACE: 'kube-system, edge'
  };
  assert.equal(
    ingressScopeMatchers('traefik', env),
    'job="my-traefik",namespace=~"kube-system|edge"'
  );
  assert.equal(ingressScopeMatchers('haproxy', {}), 'job="haproxy-ingress"');
});

test('every registered adapter answers every question or says it cannot', () => {
  for (const adapter of INGRESS_ADAPTERS) {
    const q = adapter.queries(target);
    assert.ok(q, adapter.id);
    assert.equal(q.flavor, adapter.id);
    for (const promql of [
      q.presence,
      q.requestRate('2m'),
      q.statusRate('4xx', '2m'),
      q.errorPercent('2m'),
      q.latencyAvgMs('2m'),
      q.latencyMaxMs('2m'),
      q.routeRequests('1h'),
      q.routeErrors('1h'),
      q.routeLatencyMs('1h')
    ]) {
      assert.match(promql, /ysws-flavortown/, `${adapter.id}: ${promql}`);
    }
    assert.equal(q.percentiles, q.latencyQuantileMs(0.95, '2m') !== null, adapter.id);
  }
});

test('no services means no queries, so an app without an ingress is never read as zero traffic', () => {
  for (const adapter of INGRESS_ADAPTERS) {
    assert.equal(adapter.queries({ namespace: 'ns', services: [] }), null, adapter.id);
  }
});

test('haproxy backends map back to the service', () => {
  const q = ingressQueries('haproxy', target)!;
  assert.match(
    q.requestRate('2m'),
    /proxy=~"ysws-flavortown_svc_\(web\|orchard-protection-proxy\)_\.\+"/
  );
  assert.equal(q.routeService('ysws-flavortown_svc_web_http'), 'web');
  assert.equal(
    q.routeService('ysws-flavortown_svc_orchard-protection-proxy_8080'),
    'orchard-protection-proxy'
  );
  assert.equal(q.routeService('other_svc_web_http'), null);
  assert.match(q.statusRate('5xx', '2m'), /code="5xx"/);
});

test('traefik services map back to the service and have real percentiles', () => {
  const q = ingressQueries('traefik', target)!;
  assert.equal(q.routeService('ysws-flavortown-web-3000@kubernetes'), 'web');
  assert.equal(q.routeService('ysws-flavortown-web-3000@kubernetesgateway'), 'web');
  assert.equal(q.routeService('elsewhere-web-3000@kubernetes'), null);
  assert.match(q.statusRate('4xx', '2m'), /code=~"4\.\."/);
  assert.match(q.latencyQuantileMs(0.95, '2m')!, /histogram_quantile\(0\.95/);
});

test('INGRESS_METRICS picks an adapter, K8S_INGRESS_CLASS guesses one, unknown names are ignored', () => {
  assert.equal(configuredAdapter({ INGRESS_METRICS: 'Traefik' })?.id, 'traefik');
  assert.equal(configuredAdapter({ INGRESS_METRICS: 'nginx' }), null);
  assert.equal(guessedAdapter({ K8S_INGRESS_CLASS: 'traefik,orchard' }).id, 'traefik');
  assert.equal(guessedAdapter({ INGRESS_CLASS: 'haproxy' }).id, 'haproxy');
  assert.equal(guessedAdapter({}).id, INGRESS_ADAPTERS[0].id);
});
