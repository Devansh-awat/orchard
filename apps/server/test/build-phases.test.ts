import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhases } from '../src/observability/build-phases';

test('a finished build splits into the phases it recorded', () => {
  const phases = buildPhases({
    __start: 0,
    submitted: 2_000,
    scheduled: 5_000,
    cloning: 6_000,
    building: 9_000,
    pushing: 60_000,
    deploying: 70_000,
    complete: 80_000
  });
  assert.deepEqual(
    phases.map((p) => [p.id, p.ms]),
    [
      ['queue', 2_000],
      ['schedule', 3_000],
      ['start', 1_000],
      ['clone', 3_000],
      ['build', 51_000],
      ['push', 10_000],
      ['rollout', 10_000]
    ]
  );
});

test('a skipped step is measured to the next step that happened', () => {
  const phases = buildPhases({ __start: 0, cloning: 1_000, building: 4_000, complete: 9_000 });
  assert.deepEqual(
    phases.map((p) => [p.id, p.ms]),
    [
      ['queue', 1_000],
      ['clone', 3_000],
      ['build', 5_000]
    ]
  );
});

test('runs from before step timestamps were kept have no phases', () => {
  assert.deepEqual(buildPhases(null), []);
  assert.deepEqual(buildPhases('nope'), []);
});
