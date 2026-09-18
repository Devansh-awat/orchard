import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redirectLocationFor } from '../src/auth/protection.service';

test('a redirect keeps the path and query of the request it answers', () => {
  assert.equal(
    redirectLocationFor('/docs/intro?page=2', 'https://example.com'),
    'https://example.com/docs/intro?page=2'
  );
  assert.equal(redirectLocationFor('', 'https://example.com'), 'https://example.com/');
});

test('a redirect never leaves the destination the domain was pointed at', () => {
  for (const target of [
    '//evil.example/x',
    'http://evil.example/x',
    'https://evil.example/x',
    '/\\evil.example/x',
    '//user:pw@evil.example/x'
  ]) {
    const location = redirectLocationFor(target, 'https://example.com');
    assert.equal(
      new URL(location).host,
      'example.com',
      `${target} escaped the redirect target: ${location}`
    );
  }
});

test('a redirect location cannot carry a header break into the upgrade path', () => {
  const location = redirectLocationFor('/x\r\nSet-Cookie: a=b', 'https://example.com');
  assert.equal(/[\r\n]/.test(location), false);
});
