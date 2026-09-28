import test from 'node:test';
import assert from 'node:assert/strict';
import { TemplateEngineService, type ParameterDef } from '../src/templates/template-engine.service';

const engine = new TemplateEngineService();

const appName: ParameterDef = {
  name: 'appName',
  displayName: 'App Name',
  type: 'string',
  required: true,
  validation: {
    pattern: '^[a-z][a-z0-9-]{1,58}[a-z0-9]$',
    message: 'Must be lowercase alphanumeric with hyphens, 3-60 chars'
  }
};

test('a name param with spaces is slugified instead of rejected', () => {
  const resolved = engine.validateParameters({ appName: 'My Redis Cache' }, [appName]);
  assert.equal(resolved.appName, 'my-redis-cache');
});

test('a name param that already matches is left alone', () => {
  const resolved = engine.validateParameters({ appName: 'redis' }, [appName]);
  assert.equal(resolved.appName, 'redis');
});

test('a name param that cannot be slugified into shape still fails', () => {
  assert.throws(
    () => engine.validateParameters({ appName: '!!' }, [appName]),
    /Must be lowercase alphanumeric/
  );
});

test('non-name params are never rewritten', () => {
  const image: ParameterDef = {
    name: 'redisImage',
    displayName: 'Redis Image',
    type: 'string',
    validation: { pattern: '^[a-z0-9.\\-_/]+:[a-z0-9.\\-_]+$' }
  };
  assert.throws(() => engine.validateParameters({ redisImage: 'Redis 7' }, [image]));
});

test('domain params are not treated as name params', () => {
  const hostname: ParameterDef = {
    name: 'hostname',
    displayName: 'Hostname',
    type: 'string',
    validation: { pattern: '^[a-z0-9.-]+\\.[a-z]{2,}$' }
  };
  assert.throws(() => engine.validateParameters({ hostname: 'My Site' }, [hostname]));
});

test('two expressions in one string interpolate instead of failing as one expression', () => {
  const context = {
    params: { port: 5432 },
    resources: { db: { host: 'db.internal', port: 5432 } }
  };
  assert.equal(
    engine.resolveValue('{{ resources.db.host }}:{{ resources.db.port }}', context),
    'db.internal:5432'
  );
  assert.equal(engine.resolveValue('{{ params.port }}', context), 5432);
});

test('a secret with a byte length and encoding is generated in that shape', () => {
  const [b64, hex] = [
    {
      name: 'k1',
      displayName: 'k1',
      type: 'secret',
      validation: { bytes: 32, encoding: 'base64' }
    },
    { name: 'k2', displayName: 'k2', type: 'secret', validation: { bytes: 16 } }
  ] as ParameterDef[];
  const resolved = engine.validateParameters({}, [b64, hex]);
  assert.equal(Buffer.from(resolved.k1, 'base64').length, 32);
  assert.equal(resolved.k2.length, 32);
  assert.match(resolved.k2, /^[0-9a-f]+$/);
});
