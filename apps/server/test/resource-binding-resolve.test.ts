import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UnresolvedResourceRefError,
  referencedResourceRefs,
  resolveEnvVars
} from '../src/env/env-resolver';
import {
  bindingNameFor,
  databaseFields,
  deploymentFields,
  resourceRef
} from '../src/projects/resource-bindings.service';

const db = databaseFields({
  dbUser: 'app',
  dbPassword: 'p@ss w0rd',
  host: 'midnight-web-rw.orchard-demo.svc',
  port: 5432,
  dbName: 'midnight'
});

const resources = { db: { fields: db, secretFields: ['connection_string', 'password'] } };

test('a resource reference resolves to the live value at env-build time', () => {
  const { resolved, errors } = resolveEnvVars(
    [
      { key: 'DATABASE_URL', value: '${{resource.db.connection_string}}' },
      { key: 'PGHOST', value: '${{ resource.db.host }}' },
      { key: 'PGPORT', value: '${{resource.db.port}}' }
    ],
    [],
    resources
  );
  assert.equal(errors.length, 0);
  assert.equal(
    resolved[0].value,
    'postgresql://app:p%40ss%20w0rd@midnight-web-rw.orchard-demo.svc:5432/midnight'
  );
  assert.equal(resolved[1].value, 'midnight-web-rw.orchard-demo.svc');
  assert.equal(resolved[2].value, '5432');
});

test('a value that reads a credential field becomes a secret on its way to the pod', () => {
  const { resolved } = resolveEnvVars(
    [
      { key: 'DATABASE_URL', value: '${{resource.db.connection_string}}' },
      { key: 'PGPASSWORD', value: '${{resource.db.password}}' },
      { key: 'PGHOST', value: '${{resource.db.host}}' }
    ],
    [],
    resources
  );
  assert.equal(resolved[0].secret, true);
  assert.equal(resolved[1].secret, true);
  assert.equal(resolved[2].secret, false);
});

test('an unresolvable reference fails loudly instead of shipping the literal', () => {
  assert.throws(
    () =>
      resolveEnvVars([{ key: 'DATABASE_URL', value: '${{resource.cache.url}}' }], [], resources),
    (e: unknown) =>
      e instanceof UnresolvedResourceRefError &&
      e.key === 'DATABASE_URL' &&
      e.ref === 'resource.cache.url'
  );
  assert.throws(
    () => resolveEnvVars([{ key: 'X', value: '${{resource.db.nope}}' }], [], resources),
    UnresolvedResourceRefError
  );
  assert.throws(
    () => resolveEnvVars([{ key: 'X', value: '${{resource.db.host}}' }], []),
    UnresolvedResourceRefError
  );
});

test('shared and resource references compose in one value', () => {
  const { resolved } = resolveEnvVars(
    [{ key: 'URL', value: '${{shared.SCHEME}}://${{resource.db.host}}' }],
    [{ key: 'SCHEME', value: 'postgres' }],
    resources
  );
  assert.equal(resolved[0].value, 'postgres://midnight-web-rw.orchard-demo.svc');
});

test('referenced refs are collected for save-time validation', () => {
  const refs = referencedResourceRefs([
    { key: 'A', value: '${{resource.db.host}}:${{resource.db.port}}' },
    { key: 'B', value: 'literal' },
    { key: 'C', value: '${{resource.cache.url}}' }
  ]);
  assert.deepEqual(refs, [
    { key: 'A', binding: 'db', field: 'host' },
    { key: 'A', binding: 'db', field: 'port' },
    { key: 'C', binding: 'cache', field: 'url' }
  ]);
});

test('binding names derive from the resource name and stay identifier-safe', () => {
  assert.equal(bindingNameFor('Midnight DB'), 'midnight_db');
  assert.equal(bindingNameFor('main-postgres'), 'main_postgres');
  assert.equal(bindingNameFor('2nd'), 'r_2nd');
  assert.equal(bindingNameFor('---'), 'resource');
  assert.equal(resourceRef('db', 'connection_string'), '${{resource.db.connection_string}}');
});

test('an app resolves to its first Service on the Service port, and to nothing without one', () => {
  const fields = deploymentFields('orchard-demo-midnight', [
    { name: 'api', port: 80, ports: [{ port: 8080 }] }
  ]);
  assert.equal(fields.url, 'http://api.orchard-demo-midnight.svc.cluster.local:8080');
  assert.equal(fields.host, 'api.orchard-demo-midnight.svc.cluster.local');
  assert.equal(fields.port, '8080');
  assert.deepEqual(deploymentFields('ns', []), {});
  assert.throws(
    () =>
      resolveEnvVars([{ key: 'API_URL', value: '${{resource.api.url}}' }], [], {
        api: { fields: deploymentFields('ns', []) }
      }),
    UnresolvedResourceRefError
  );
});
