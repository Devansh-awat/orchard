/**
 * Unit tests for ApiThrottlerGuard's tracker/limit behavior.
 *
 * Instantiates the guard directly (no Nest app, no DB) and checks that
 * PAT-bearing requests get per-token buckets keyed on a sha256 of the token
 * while everything else keeps the per-IP tracker.
 *
 * Run:
 *   pnpm test:throttler
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ApiThrottlerGuard,
  apiThrottlerLimit,
  bearerApiToken,
  API_TOKEN_RATE_LIMIT,
  IP_RATE_LIMIT
} from '../src/auth/api-throttler.guard';

const PAT = 'orch_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_PAT = 'orch_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function makeRequest(authorization?: unknown, ip = '203.0.113.7'): Record<string, any> {
  const headers: Record<string, unknown> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return { headers, ip };
}

function makeGuard(): ApiThrottlerGuard {
  return new ApiThrottlerGuard([{ ttl: 60000, limit: IP_RATE_LIMIT }] as any, {} as any, {} as any);
}

function getTracker(guard: ApiThrottlerGuard, req: Record<string, any>): Promise<string> {
  return (guard as any).getTracker(req);
}

function httpContext(req: Record<string, any>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req })
  } as any;
}

test('bearerApiToken extracts orch_ bearers and nothing else', () => {
  assert.equal(bearerApiToken(makeRequest(`Bearer ${PAT}`)), PAT);
  assert.equal(bearerApiToken(makeRequest('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')), undefined);
  assert.equal(bearerApiToken(makeRequest('Basic orch_abc')), undefined);
  assert.equal(bearerApiToken(makeRequest(['Bearer', PAT])), undefined);
  assert.equal(bearerApiToken(makeRequest()), undefined);
  assert.equal(bearerApiToken({}), undefined);
});

test('PAT requests are tracked per token, not per IP', async () => {
  const guard = makeGuard();
  const fromHostA = await getTracker(guard, makeRequest(`Bearer ${PAT}`, '198.51.100.1'));
  const fromHostB = await getTracker(guard, makeRequest(`Bearer ${PAT}`, '203.0.113.7'));
  assert.equal(fromHostA, fromHostB);

  const otherToken = await getTracker(guard, makeRequest(`Bearer ${OTHER_PAT}`, '198.51.100.1'));
  assert.notEqual(fromHostA, otherToken);
});

test('PAT tracker is the sha256 of the token, never the raw token', async () => {
  const guard = makeGuard();
  const tracker = await getTracker(guard, makeRequest(`Bearer ${PAT}`));
  assert.equal(tracker, `token:${createHash('sha256').update(PAT).digest('hex')}`);
  assert.ok(!tracker.includes(PAT));
});

test('non-PAT requests keep the IP tracker', async () => {
  const guard = makeGuard();
  assert.equal(await getTracker(guard, makeRequest(undefined, '198.51.100.1')), '198.51.100.1');
  assert.equal(
    await getTracker(guard, makeRequest('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x', '198.51.100.1')),
    '198.51.100.1'
  );
});

test('apiThrottlerLimit gives PAT buckets more headroom', () => {
  assert.equal(apiThrottlerLimit(httpContext(makeRequest(`Bearer ${PAT}`))), API_TOKEN_RATE_LIMIT);
  assert.equal(apiThrottlerLimit(httpContext(makeRequest())), IP_RATE_LIMIT);
  assert.equal(apiThrottlerLimit({ getType: () => 'ws' } as any), IP_RATE_LIMIT);
});
