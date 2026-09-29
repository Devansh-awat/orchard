import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastingFailures,
  shardIsStale,
  STALE_MS,
  UNHEALTHY_GRACE_MS
} from '../src/mirror/mirror-health';

const now = 1_000_000;

test('a released shard with a fresh heartbeat is a handoff, not an outage', () => {
  assert.equal(
    shardIsStale({ holder: null, updatedAt: new Date(now - 5_000), healthy: true }, now),
    false
  );
});

test('a shard nobody has heartbeated for a minute is stale whoever holds it', () => {
  assert.equal(
    shardIsStale({ holder: 'a', updatedAt: new Date(now - STALE_MS - 1), healthy: true }, now),
    true
  );
  assert.equal(
    shardIsStale({ holder: null, updatedAt: new Date(now - STALE_MS - 1), healthy: true }, now),
    true
  );
});

test('a holder that reports its watch down is stale even with a fresh heartbeat', () => {
  assert.equal(
    shardIsStale({ holder: 'a', updatedAt: new Date(now - 1_000), healthy: false }, now),
    true
  );
});

test('watch failures only count once they have lasted the grace period', () => {
  const failures = new Map([
    ['pods', { error: 'watch closed', since: now - 2_000 }],
    ['services', { error: 'forbidden', since: now - UNHEALTHY_GRACE_MS }]
  ]);
  assert.deepEqual(lastingFailures(failures, now), [['services', 'forbidden']]);
  assert.deepEqual(lastingFailures(failures, now + UNHEALTHY_GRACE_MS), [
    ['pods', 'watch closed'],
    ['services', 'forbidden']
  ]);
});
