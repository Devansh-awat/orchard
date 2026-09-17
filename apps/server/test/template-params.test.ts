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
