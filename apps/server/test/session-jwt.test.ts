import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserSession, NotBrowserSessionError } from '../src/auth/session-jwt';

test('a typeless payload with a sessionId is a browser session', () => {
  assert.equal(assertBrowserSession({ sub: 'u1', sessionId: 'sess-1' }), 'sess-1');
});

test('mcp and mcp_refresh tokens never open a shell', () => {
  for (const type of ['mcp', 'mcp_refresh']) {
    assert.throws(
      () => assertBrowserSession({ sub: 'u1', sessionId: 'sess-1', type }),
      NotBrowserSessionError
    );
  }
});

test('any other kind claim is rejected, even an empty one', () => {
  assert.throws(() => assertBrowserSession({ sessionId: 'sess-1', type: '' }));
  assert.throws(() => assertBrowserSession({ sessionId: 'sess-1', type: null }));
  assert.throws(() => assertBrowserSession({ sessionId: 'sess-1', type: 'sandbox' }));
});

test('a session binding is required and must be a non-empty string', () => {
  assert.throws(() => assertBrowserSession({ sub: 'u1' }), NotBrowserSessionError);
  assert.throws(() => assertBrowserSession({ sub: 'u1', sessionId: '' }), NotBrowserSessionError);
  assert.throws(() => assertBrowserSession({ sub: 'u1', sessionId: 42 }), NotBrowserSessionError);
  assert.throws(() => assertBrowserSession({ sub: 'u1', sessionId: null }), NotBrowserSessionError);
});
