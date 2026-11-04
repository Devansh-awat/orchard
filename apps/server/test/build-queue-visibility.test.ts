import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentsService } from '../src/projects/deployments.service';
import type { QueueSnapshot } from '../src/projects/build-queue.service';

// `queuedBuild` is private because nothing else should build this envelope, but
// it is the entire contract an API client has for "accepted but not started".
const queuedBuild = (runId: string, queue: QueueSnapshot) =>
  (DeploymentsService as any).queuedBuild(runId, queue) as {
    accepted: boolean;
    started: boolean;
    status: string;
    runId: string;
    waiting: number;
    running: number;
    slots: number;
    message: string;
  };

const full: QueueSnapshot = {
  running: 2,
  limit: 2,
  waiting: 1,
  blockedByOwnBuild: false,
  pool: 'cluster'
};

// The bug this exists for: a queued rebuild returned the unchanged deployment,
// so a client saw the previous build record and concluded the call did nothing.
test('a queued rebuild says it was accepted and has not started', () => {
  const build = queuedBuild('run-1', full);
  assert.equal(build.accepted, true);
  assert.equal(build.started, false);
  assert.equal(build.status, 'queued');
  assert.equal(build.runId, 'run-1');
});

test('the message says why, in numbers a caller can act on', () => {
  const build = queuedBuild('run-1', full);
  assert.match(build.message, /All 2 build slots are busy/);
  assert.equal(build.running, 2);
  assert.equal(build.slots, 2);
  assert.equal(build.waiting, 1);
});

test('one slot reads as a slot, not slots', () => {
  const build = queuedBuild('run-1', { ...full, running: 1, limit: 1 });
  assert.match(build.message, /All 1 build slot is busy/);
});

// Waiting on your own build is a different situation from waiting on the pool,
// and telling them apart is the difference between "wait" and "something is stuck".
test('waiting on this deployment’s own build says so', () => {
  const build = queuedBuild('run-1', { ...full, blockedByOwnBuild: true });
  assert.match(build.message, /already building/);
  assert.doesNotMatch(build.message, /slots are busy/);
});

// An agent that retries on a queued build supersedes its own request forever.
test('every queued message tells the caller not to retry', () => {
  for (const blocked of [true, false]) {
    const build = queuedBuild('run-1', { ...full, blockedByOwnBuild: blocked });
    assert.match(build.message, /don't retry/i);
  }
});
