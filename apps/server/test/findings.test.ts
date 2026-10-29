import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockFor,
  detectionStep,
  forecastSentence,
  toCauses
} from '../src/observability/findings.service';

const NOW = Date.UTC(2026, 9, 28, 12, 0);

test('times read in the viewer zone and say tomorrow when they roll over', () => {
  const clock = clockFor('America/New_York', NOW);
  assert.equal(clock(Date.UTC(2026, 9, 28, 14, 2)), '10:02');
  assert.equal(clock(Date.UTC(2026, 9, 29, 13, 0)), 'tomorrow 09:00');
});

test('an unknown zone falls back to UTC and says so', () => {
  assert.equal(clockFor('Mars/Olympus', NOW)(Date.UTC(2026, 9, 28, 14, 2)), '14:02 UTC');
  assert.equal(clockFor(null, NOW)(Date.UTC(2026, 9, 28, 14, 2)), '14:02 UTC');
});

test('the forecast sentence leads with the trend and ends with when', () => {
  const sentence = forecastSentence(
    {
      slopeBytesPerHour: 40 * 1024 * 1024,
      since: Date.UTC(2026, 9, 28, 9, 10),
      hitsLimitAt: Date.UTC(2026, 9, 28, 17, 30)
    },
    clockFor('UTC', NOW)
  );
  assert.equal(
    sentence,
    'Memory has climbed about 40 MiB an hour since 09:10 and reaches its limit around 17:30.'
  );
});

test('detection steps coarsen with the range', () => {
  assert.equal(detectionStep(60 * 60_000), 60_000);
  assert.equal(detectionStep(24 * 60 * 60_000), 5 * 60_000);
  assert.equal(detectionStep(7 * 24 * 60 * 60_000), 30 * 60_000);
});

test('changes without a cause clause or kind never become causes', () => {
  const causes = toCauses([
    {
      id: 'a',
      t: 1,
      kind: 'deploy',
      tone: 'deploy',
      label: 'v7 went live',
      detail: null,
      cause: 'v7 went live',
      actor: null
    },
    {
      id: 'b',
      t: 2,
      kind: 'build',
      tone: 'error',
      label: 'Build failed',
      detail: null,
      cause: null,
      actor: null
    }
  ]);
  assert.deepEqual(causes, [
    { id: 'a', t: 1, kind: 'deploy', label: 'v7 went live', phrase: 'v7 went live', actor: null }
  ]);
});
