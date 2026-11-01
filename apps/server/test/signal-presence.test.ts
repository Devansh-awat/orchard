import assert from 'node:assert/strict';
import test from 'node:test';
import { INGRESS_ADAPTERS } from '../src/metrics/ingress';
import {
  hasContainerSignal,
  httpFlavors,
  presenceQueries,
  type SignalPresence
} from '../src/metrics/signal-presence';

const presence: SignalPresence = {
  namespaces: ['ysws-3kh0-s-project', 'kube-system'],
  http: {
    haproxy: [
      'ysws-3kh0-s-project_svc_alchemize_port-1',
      'ysws-3kh0-s-project_svc_orchard-protection-proxy_3001',
      'ysws-calsync_svc_calsync_http'
    ],
    traefik: ['ysws-hackcast-web-3000@kubernetes']
  }
};

test('one grouped query per signal, cluster wide, so no app pays for its own presence check', () => {
  const q = presenceQueries();
  assert.match(q.namespaces.query, /^count by \(namespace\) \(last_over_time\(/);
  assert.equal(q.namespaces.label, 'namespace');
  for (const adapter of INGRESS_ADAPTERS) {
    const h = q.http[adapter.id];
    assert.ok(h, adapter.id);
    assert.equal(h.label, adapter.presenceLabel);
    assert.ok(h.query.includes(adapter.presenceMetric), adapter.id);
    assert.doesNotMatch(h.query, /namespace=|proxy=~|service=~/);
  }
});

test('container signal is an exact namespace match', () => {
  assert.equal(hasContainerSignal(presence, 'ysws-3kh0-s-project'), true);
  assert.equal(hasContainerSignal(presence, 'ysws-3kh0'), false);
  assert.equal(hasContainerSignal(presence, null), false);
});

test('http presence matches the same backends the adapter selector would', () => {
  assert.deepEqual(
    httpFlavors(presence, { namespace: 'ysws-3kh0-s-project', services: ['alchemize'] }),
    ['haproxy']
  );
  assert.deepEqual(
    httpFlavors(presence, {
      namespace: 'ysws-3kh0-s-project',
      services: ['web', 'orchard-protection-proxy']
    }),
    ['haproxy']
  );
  assert.deepEqual(
    httpFlavors(presence, { namespace: 'ysws-3kh0-s-project', services: ['web'] }),
    []
  );
  assert.deepEqual(httpFlavors(presence, { namespace: 'ysws-3kh0', services: ['alchemize'] }), []);
  assert.deepEqual(httpFlavors(presence, { namespace: 'ysws-hackcast', services: ['web'] }), [
    'traefik'
  ]);
  assert.deepEqual(httpFlavors(presence, { namespace: 'ysws-hackcast', services: [] }), []);
});

test('a missing adapter in the snapshot reads as no traffic, not an error', () => {
  assert.deepEqual(
    httpFlavors({ namespaces: [], http: {} }, { namespace: 'ns', services: ['web'] }),
    []
  );
});
