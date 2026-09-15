import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRequestPath,
  normalizeBypassPath,
  pathMatchesBypass
} from '../src/auth/protection.service';

test('request paths drop query strings and fragments', () => {
  assert.equal(normalizeRequestPath('/api/users?page=2'), '/api/users');
  assert.equal(normalizeRequestPath('/api/users#frag'), '/api/users');
  assert.equal(normalizeRequestPath('/'), '/');
  assert.equal(normalizeRequestPath(''), '/');
});

test('request paths collapse traversal before matching', () => {
  assert.equal(normalizeRequestPath('/api/../admin'), '/admin');
  assert.equal(normalizeRequestPath('/api/./v1'), '/api/v1');
  assert.equal(normalizeRequestPath('/api//v1'), '/api/v1');
  assert.equal(normalizeRequestPath('/api/%2e%2e/admin'), '/admin');
  assert.equal(normalizeRequestPath('/api%2f..%2fadmin'), '/admin');
});

test('a traversal out of a bypassed prefix does not bypass', () => {
  const patterns = ['/api'];
  assert.equal(pathMatchesBypass(normalizeRequestPath('/api/users'), patterns), true);
  assert.equal(pathMatchesBypass(normalizeRequestPath('/api/../admin'), patterns), false);
  assert.equal(pathMatchesBypass(normalizeRequestPath('/api/%2e%2e/admin'), patterns), false);
});

test('prefix matching only happens on segment boundaries', () => {
  const patterns = ['/api'];
  assert.equal(pathMatchesBypass('/api', patterns), true);
  assert.equal(pathMatchesBypass('/api/v1/users', patterns), true);
  assert.equal(pathMatchesBypass('/apikeys', patterns), false);
  assert.equal(pathMatchesBypass('/api-internal', patterns), false);
  assert.equal(pathMatchesBypass('/private/api', patterns), false);
});

test('empty pattern lists never bypass', () => {
  assert.equal(pathMatchesBypass('/api', []), false);
  assert.equal(pathMatchesBypass('/api', undefined as unknown as string[]), false);
});

test('a bare slash pattern is ignored rather than opening everything', () => {
  assert.equal(normalizeBypassPath('/'), null);
  assert.equal(normalizeBypassPath('/*'), null);
  assert.equal(pathMatchesBypass('/anything', ['/']), false);
});

test('bypass patterns accept a trailing star and normalize', () => {
  assert.equal(normalizeBypassPath('/api/*'), '/api');
  assert.equal(normalizeBypassPath('/api/'), '/api');
  assert.equal(normalizeBypassPath('  /api/v1  '), '/api/v1');
  assert.equal(normalizeBypassPath('/api/../admin'), '/admin');
});

test('bypass patterns reject malformed input', () => {
  assert.equal(normalizeBypassPath('api'), null);
  assert.equal(normalizeBypassPath('https://evil.test/api'), null);
  assert.equal(normalizeBypassPath('/api users'), null);
  assert.equal(normalizeBypassPath(''), null);
  assert.equal(normalizeBypassPath('/'.padEnd(250, 'a')), null);
  assert.equal(normalizeBypassPath(null as unknown as string), null);
});
