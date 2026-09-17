import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartedAtFrom } from '../src/projects/build-timing';

test('reads the epoch-ms start a build records when it is triggered', () => {
  const start = Date.UTC(2026, 8, 16, 21, 3, 3);
  assert.deepEqual(
    buildStartedAtFrom({ __start: start, pushing: start + 60_000 }),
    new Date(start)
  );
});

test('falls back to null when a build recorded no start', () => {
  assert.equal(buildStartedAtFrom(null), null);
  assert.equal(buildStartedAtFrom(undefined), null);
  assert.equal(buildStartedAtFrom({}), null);
  assert.equal(buildStartedAtFrom({ pushing: 123 }), null);
});

test('rejects a start that is not a usable timestamp', () => {
  assert.equal(buildStartedAtFrom({ __start: 0 }), null);
  assert.equal(buildStartedAtFrom({ __start: -1 }), null);
  assert.equal(buildStartedAtFrom({ __start: NaN }), null);
  assert.equal(buildStartedAtFrom({ __start: Infinity }), null);
  assert.equal(buildStartedAtFrom({ __start: '1758056583000' }), null);
  assert.equal(buildStartedAtFrom({ __start: 8.64e15 + 1 }), null);
});
