import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import { createHash } from 'node:crypto';
import { checkRefreshGeneration, oauthCodeKey } from '../src/mcp/mcp-oauth.helpers';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-refresh-rotation';

test('a refresh token at the current generation is accepted', () => {
  assert.deepEqual(checkRefreshGeneration(3, 3), { ok: true, gen: 3 });
});

test('a refresh token from a previous generation is rejected', () => {
  const result = checkRefreshGeneration(2, 3);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'refresh token already rotated');
});

test('a refresh token claiming a future generation is rejected', () => {
  assert.equal(checkRefreshGeneration(4, 3).ok, false);
});

test('a legacy refresh token with no gen claim counts as generation zero', () => {
  assert.deepEqual(checkRefreshGeneration(undefined, 0), { ok: true, gen: 0 });
  assert.equal(checkRefreshGeneration(undefined, 1).ok, false);
});

test('malformed gen claims are rejected', () => {
  for (const claim of ['1', 1.5, -1, null, {}, NaN]) {
    const result = checkRefreshGeneration(claim, 0);
    assert.equal(result.ok, false, `claim ${String(claim)} should be rejected`);
    if (!result.ok) assert.equal(result.reason, 'malformed generation');
  }
});

test('minted refresh tokens carry the generation they were issued at', async () => {
  const svc = new McpOAuthService({} as any, {} as any);
  const token = await (svc as any).mintRefreshToken(
    { sub: 'user-1', sessionId: 'session-1', authMethod: 'otp' },
    'client-1',
    7
  );
  const claims = decodeJwt(token);
  assert.equal(claims.type, 'mcp_refresh');
  assert.equal(claims.gen, 7);
  assert.equal(claims.clientId, 'client-1');
});

test('the refresh grant rotates the generation and issues the next one', async () => {
  const calls: string[] = [];
  let generation = 4;
  const sessions = {
    refreshGeneration: async () => {
      calls.push('read');
      return generation;
    },
    rotateRefreshGeneration: async (_id: string, expected: number) => {
      calls.push(`rotate:${expected}`);
      if (expected !== generation) return null;
      generation += 1;
      return generation;
    },
    revokeSession: async () => {
      calls.push('revoke');
      return true;
    },
    extendSession: async () => {
      calls.push('extend');
    }
  };
  const svc = new McpOAuthService(sessions as any, {} as any);
  const refreshToken = await (svc as any).mintRefreshToken(
    { sub: 'user-1', sessionId: 'session-1', authMethod: 'otp' },
    'client-1',
    4
  );

  const first = await (svc as any).refreshAccessToken({
    refresh_token: refreshToken,
    client_id: 'client-1'
  });
  assert.ok(first.token_response, JSON.stringify(first));
  assert.equal(decodeJwt(first.token_response.refresh_token).gen, 5);
  assert.deepEqual(calls, ['read', 'rotate:4', 'extend']);

  const replay = await (svc as any).refreshAccessToken({
    refresh_token: refreshToken,
    client_id: 'client-1'
  });
  assert.equal(replay.error, 'invalid_grant');
  assert.ok(calls.includes('revoke'), 'reusing a rotated refresh token revokes the session');
});

test('auth code rows are keyed by the sha256 of the code', () => {
  const code = 'a'.repeat(64);
  assert.equal(oauthCodeKey(code), createHash('sha256').update(code).digest('hex'));
  assert.notEqual(oauthCodeKey(code), code);
  assert.equal(oauthCodeKey(code), oauthCodeKey(code));
});
