import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSymptoms, episodes, memoryStep, restartBursts } from '../src/observability/symptoms';
import { correlate } from '../src/observability/correlate';

const STEP = 60_000;
const T0 = Date.UTC(2026, 9, 28, 13, 0);
const series = (values: number[]) => values.map((y, i) => ({ x: T0 + i * STEP, y }));
const MIB = 1024 * 1024;

test('episodes need a sustained run above the threshold', () => {
  const pts = series([0, 5, 0, 5, 5, 5, 0]);
  assert.deepEqual(episodes(pts, 1), [{ start: 3, end: 5 }]);
});

test('an error spike becomes one symptom with its before and peak', () => {
  const values = [...Array(40).fill(0.2), 4, 4.1, 3.9, ...Array(10).fill(0.2)];
  const [s] = detectSymptoms({ errorPct: series(values) });
  assert.equal(s.kind, 'error-rate');
  assert.equal(s.onset, T0 + 40 * STEP);
  assert.equal(s.before, 0.2);
  assert.equal(s.after, 4.1);
  assert.equal(s.presentBefore, false);
  assert.equal(s.end, T0 + 42 * STEP);
});

test('noise under the floor is not a symptom', () => {
  const values = Array.from({ length: 60 }, (_, i) => 0.2 + (i % 3) * 0.1);
  assert.deepEqual(detectSymptoms({ errorPct: series(values) }), []);
});

test('a second episode inside 30 minutes is already present', () => {
  const values = [...Array(20).fill(0.1), 3, 3, ...Array(5).fill(0.1), 3, 3, ...Array(5).fill(0.1)];
  const found = detectSymptoms({ errorPct: series(values) });
  assert.equal(found.length, 2);
  assert.equal(found[0].presentBefore, false);
  assert.equal(found[1].presentBefore, true);
});

test('throttling uses an absolute 25 percent floor and averages the episode', () => {
  const values = [...Array(10).fill(5), 40, 36, ...Array(3).fill(5)];
  const [s] = detectSymptoms({ throttledPct: series(values) });
  assert.equal(s.kind, 'throttling');
  assert.equal(s.after, 38);
});

test('memory steps need 64 MiB and 30 percent', () => {
  const up = series([...Array(12).fill(200 * MIB), ...Array(12).fill(400 * MIB)]);
  const [s] = memoryStep(up);
  assert.equal(s.kind, 'memory-step');
  assert.equal(s.onset, T0 + 12 * STEP);
  assert.equal(
    memoryStep(series([...Array(12).fill(200 * MIB), ...Array(12).fill(230 * MIB)])).length,
    0
  );
});

test('restart bursts count restarts inside ten minutes', () => {
  const pts = series([0, 1, 0, 1, 0, 1, ...Array(20).fill(0), 1]);
  const [s] = restartBursts(pts);
  assert.equal(s.after, 3);
  assert.equal(restartBursts(series([1, ...Array(20).fill(0), 1])).length, 0);
});

test('symptoms and changes make a sentence that leads with the observation', () => {
  const values = [...Array(40).fill(0.2), 4, 4.1, ...Array(10).fill(0.2)];
  const symptoms = detectSymptoms({ errorPct: series(values) });
  const findings = correlate({
    symptoms,
    changes: [{ id: 'release:1', t: T0 + 38 * STEP, kind: 'deploy', label: 'v7' }],
    formatTime: (ms) => new Date(ms).toISOString().slice(11, 16)
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].causeId, 'release:1');
  assert.match(
    findings[0].sentence,
    /^Errors went from 0\.2% to 4\.1% at 13:40, two minutes after v7 went live\.$/
  );
});
