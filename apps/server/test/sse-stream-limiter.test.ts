import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SSE_STREAMS_PER_RESOURCE,
  MAX_SSE_STREAMS_PER_USER,
  SseStreamLimiter,
  TooManyStreamsException
} from '../src/events/sse-stream-limiter';

test('a user gets at most five streams on one resource', () => {
  const limiter = new SseStreamLimiter();
  const releases = [];
  for (let i = 0; i < MAX_SSE_STREAMS_PER_RESOURCE; i += 1) {
    releases.push(limiter.acquire('u1', 'org:a'));
  }
  assert.throws(() => limiter.acquire('u1', 'org:a'), TooManyStreamsException);
  assert.equal(limiter.count('u1', 'org:a'), MAX_SSE_STREAMS_PER_RESOURCE);
  releases[0]();
  assert.doesNotThrow(() => limiter.acquire('u1', 'org:a'));
});

test('the per-resource cap is scoped to the user', () => {
  const limiter = new SseStreamLimiter();
  for (let i = 0; i < MAX_SSE_STREAMS_PER_RESOURCE; i += 1) limiter.acquire('u1', 'org:a');
  assert.doesNotThrow(() => limiter.acquire('u2', 'org:a'));
});

test('twenty streams across every resource is the ceiling for one user', () => {
  const limiter = new SseStreamLimiter();
  for (let i = 0; i < MAX_SSE_STREAMS_PER_USER; i += 1) {
    limiter.acquire('u1', `build:${i}`);
  }
  assert.equal(limiter.count('u1'), MAX_SSE_STREAMS_PER_USER);
  assert.throws(
    () => limiter.acquire('u1', 'org:fresh'),
    (err: TooManyStreamsException) => {
      assert.equal(err.getStatus(), 429);
      assert.match(err.message, /for this user/);
      return true;
    }
  );
  assert.doesNotThrow(() => limiter.acquire('u2', 'org:fresh'));
});

test('release is idempotent and never goes negative', () => {
  const limiter = new SseStreamLimiter();
  const release = limiter.acquire('u1', 'org:a');
  release();
  release();
  assert.equal(limiter.count('u1'), 0);
  assert.equal(limiter.count('u1', 'org:a'), 0);
  limiter.acquire('u1', 'org:a');
  assert.equal(limiter.count('u1'), 1);
});

test('a rejected acquire does not consume a slot', () => {
  const limiter = new SseStreamLimiter();
  for (let i = 0; i < MAX_SSE_STREAMS_PER_RESOURCE; i += 1) limiter.acquire('u1', 'org:a');
  assert.throws(() => limiter.acquire('u1', 'org:a'));
  assert.equal(limiter.count('u1'), MAX_SSE_STREAMS_PER_RESOURCE);
});
