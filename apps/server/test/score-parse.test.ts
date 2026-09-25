import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScore, summarize, translatePlaceholders } from '../src/score/score-parse';

const SCORE = `
apiVersion: score.dev/v1b1
metadata:
  name: midnight-web
  annotations:
    orchard.my/domain: midnight.example.com
    orchard.my/replicas: "2"
    orchard.my/health-path: /healthz
containers:
  web:
    image: .
    variables:
      DATABASE_URL: \${resources.db.connection_string}
      PGHOST: \${resources.db.host}
      DB_NAME: \${resources.db.name}
      LOG_LEVEL: info
service:
  ports:
    www:
      port: 8080
      targetPort: 3000
    metrics:
      port: 9100
      protocol: udp
resources:
  db:
    type: postgres
  cache:
    type: redis
  dns:
    type: dns
`;

test('a score workload maps onto an app, its ports, a database and live references', () => {
  const plan = parseScore(SCORE);
  assert.ok(plan);
  assert.equal(plan.name, 'midnight-web');
  assert.equal(plan.container, 'web');
  assert.equal(plan.image, null);
  assert.deepEqual(
    plan.ports.map((p) => [p.name, p.port, p.targetPort, p.protocol]),
    [
      ['www', 8080, 3000, 'TCP'],
      ['metrics', 9100, 9100, 'UDP']
    ]
  );
  assert.deepEqual(plan.env, [
    { key: 'DATABASE_URL', value: '${{resource.db.connection_string}}' },
    { key: 'PGHOST', value: '${{resource.db.host}}' },
    { key: 'DB_NAME', value: '${{resource.db.database}}' },
    { key: 'LOG_LEVEL', value: 'info' }
  ]);
  assert.deepEqual(
    plan.resources.map((r) => [r.name, r.type]),
    [
      ['db', 'postgres'],
      ['cache', 'redis'],
      ['dns', 'unsupported']
    ]
  );
  assert.equal(plan.domain, 'midnight.example.com');
  assert.equal(plan.replicas, 2);
  assert.equal(plan.healthPath, '/healthz');
  assert.ok(plan.warnings.some((w) => w.includes('cache')));
  assert.ok(plan.warnings.some((w) => w.includes('dns')));
});

test('a reference to something not provisioned is kept verbatim and called out', () => {
  const { value, unknown } = translatePlaceholders('${resources.cache.url}', [
    { name: 'db', type: 'postgres', rawType: 'postgres' }
  ]);
  assert.equal(value, '${resources.cache.url}');
  assert.deepEqual(unknown, ['cache.url']);
});

test('a file that is not a score workload is ignored rather than trusted', () => {
  assert.equal(parseScore(''), null);
  assert.equal(parseScore('not: [yaml'), null);
  assert.equal(parseScore('apiVersion: v1\nkind: Pod\nmetadata:\n  name: x'), null);
  assert.equal(
    parseScore('apiVersion: score.dev/v1b1\nmetadata:\n  name: Bad Name\ncontainers: {}'),
    null
  );
  assert.equal(
    parseScore('apiVersion: score.dev/v1b1\nmetadata:\n  name: ok\ncontainers: {}'),
    null
  );
});

test('bad ports, bad variable names and a bad replica count are skipped with a warning', () => {
  const plan = parseScore(`
apiVersion: score.dev/v1b1
metadata:
  name: app
  annotations:
    orchard.my/replicas: many
containers:
  main:
    image: ghcr.io/o/app:1
    variables:
      "BAD-KEY": x
      GOOD: y
service:
  ports:
    www:
      port: 80
    broken:
      port: 70000
`);
  assert.ok(plan);
  assert.equal(plan.image, 'ghcr.io/o/app:1');
  assert.deepEqual(plan.env, [{ key: 'GOOD', value: 'y' }]);
  assert.deepEqual(
    plan.ports.map((p) => p.port),
    [80]
  );
  assert.equal(plan.replicas, null);
  assert.equal(plan.warnings.length, 3);
  const summary = summarize('score.yaml', plan);
  assert.deepEqual(summary.ports, [80]);
  assert.equal(summary.name, 'app');
});
