import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry, requiredScopeOf } from '../src/registry';

test('a documented scope matches the scope the API enforces', () => {
  for (const route of registry) {
    if (!route.scope) continue;
    assert.equal(route.scope, requiredScopeOf(route), `${route.method} ${route.path}`);
  }
});

test('routes without @RequireScope fall back to the method default', () => {
  assert.equal(requiredScopeOf({ method: 'GET' }), 'read');
  assert.equal(requiredScopeOf({ method: 'POST' }), 'deploy');
  assert.equal(requiredScopeOf({ method: 'GET', requiredScope: 'exec' }), 'exec');
});
