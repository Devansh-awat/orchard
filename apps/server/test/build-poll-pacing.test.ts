import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnseenTerminalSignal, remainingIntervalMs } from '../src/docker/build-poll-pacing';

const POLL_INTERVAL = 3000;

/**
 * Replays the pacing half of waitForBuildJob's loop against an informer that
 * behaves like the real one: once a job is deleted or completes, waitForTerminal
 * stops blocking and returns the same cached observation instantly, forever.
 * Returns how long the loop would have spent sleeping across `iterations`.
 */
function simulateLoop(opts: {
  iterations: number;
  waitResolvesAfterMs: (i: number) => number;
  observationAt: (i: number) => number | null;
}) {
  let lastSeenAt = 0;
  let totalSleep = 0;
  let earlyWakes = 0;

  for (let i = 0; i < opts.iterations; i++) {
    const at = opts.observationAt(i);
    const terminal = at === null ? null : { at };
    const earlyWakeEarned = isUnseenTerminalSignal(terminal, lastSeenAt);
    if (earlyWakeEarned && terminal) {
      lastSeenAt = terminal.at;
      earlyWakes++;
    }
    totalSleep += remainingIntervalMs(
      POLL_INTERVAL,
      opts.waitResolvesAfterMs(i),
      earlyWakeEarned,
    );
  }

  return { totalSleep, earlyWakes };
}

test('a deleted job does not collapse the poll interval to zero', () => {
  // The informer holds phase=gone from the moment the job is deleted, so every
  // waitForTerminal call returns the same observation with zero delay. This is
  // exactly the case that produced poll #2354 inside a 15s grace window.
  const { totalSleep, earlyWakes } = simulateLoop({
    iterations: 5,
    waitResolvesAfterMs: () => 0,
    observationAt: () => 1000,
  });

  assert.equal(earlyWakes, 1, 'the vanish should be acted on exactly once');
  assert.equal(
    totalSleep,
    POLL_INTERVAL * 4,
    'every iteration after the first must wait out the full interval',
  );
});

test('a genuine new transition still wakes the loop early', () => {
  // pending -> running -> succeeded: each distinct observation earns its early
  // wake, so the informer keeps its latency benefit over fixed polling.
  const transitions = [null, 500, 900];
  const { totalSleep, earlyWakes } = simulateLoop({
    iterations: 3,
    waitResolvesAfterMs: (i) => (i === 0 ? POLL_INTERVAL : 10),
    observationAt: (i) => transitions[i],
  });

  assert.equal(earlyWakes, 2);
  assert.equal(totalSleep, 0, 'real transitions should not be delayed');
});

test('no informer falls back to a fixed interval', () => {
  const { totalSleep, earlyWakes } = simulateLoop({
    iterations: 4,
    waitResolvesAfterMs: () => 0,
    observationAt: () => null,
  });

  assert.equal(earlyWakes, 0);
  assert.equal(totalSleep, POLL_INTERVAL * 4);
});

test('a slow wait is not double-charged', () => {
  // waitForTerminal already blocked for most of the interval; only the
  // remainder should be slept, and a wait that ran long sleeps nothing.
  assert.equal(remainingIntervalMs(POLL_INTERVAL, 2500, false), 500);
  assert.equal(remainingIntervalMs(POLL_INTERVAL, POLL_INTERVAL, false), 0);
  assert.equal(remainingIntervalMs(POLL_INTERVAL, 9999, false), 0);
});

test('the same timestamp is only ever consumed once', () => {
  assert.equal(isUnseenTerminalSignal({ at: 42 }, 0), true);
  assert.equal(isUnseenTerminalSignal({ at: 42 }, 42), false);
  assert.equal(isUnseenTerminalSignal(null, 0), false);
  assert.equal(isUnseenTerminalSignal(undefined, 0), false);
});
