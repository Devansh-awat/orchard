import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_ENOUGH_HISTORY_REASON,
  dailyPeaks,
  formatBytes,
  formatCpu,
  quantile,
  recommendResources,
  roundCpu,
  roundMemory,
  type RightsizingInput,
  type RightsizingSample
} from '../src/rightsizing/recommend';

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const STEP = 5 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 0, 0, 0);
const HEDGES = /\b(likely|may|seems|appears|potentially)\b/i;

interface Shape {
  memory?: (i: number, t: number) => number;
  cpu?: (i: number, t: number) => number;
  throttle?: (i: number, t: number) => number;
}

function samples(days: number, shape: Shape = {}): RightsizingSample[] {
  const count = Math.round((days * DAY) / STEP);
  const out: RightsizingSample[] = [];
  for (let i = 0; i < count; i++) {
    const t = NOW - i * STEP;
    out.push({
      t,
      memoryBytes: shape.memory ? shape.memory(i, t) : 100 * MiB,
      cpuMilli: shape.cpu ? shape.cpu(i, t) : 50,
      throttledPercent: shape.throttle ? shape.throttle(i, t) : null
    });
  }
  return out;
}

function input(overrides: Partial<RightsizingInput> = {}): RightsizingInput {
  return {
    samples: samples(14),
    current: { cpuLimitMilli: 250, memoryBytes: 512 * MiB },
    image: 'ghcr.io/acme/web:1.0.0',
    oomKilled: false,
    restartsLast24h: 0,
    restartsInWindow: 0,
    now: NOW,
    ...overrides
  };
}

function assertPlainReason(reason: string) {
  assert.ok(!HEDGES.test(reason), reason);
  assert.ok(!reason.includes('—'), reason);
  assert.match(reason, /^[A-Z]/);
  assert.match(reason, /\.$/);
}

test('quantile interpolates between sorted values', () => {
  assert.equal(quantile([], 0.95), 0);
  assert.equal(quantile([5], 0.5), 5);
  assert.equal(quantile([3, 1, 2, 4], 0), 1);
  assert.equal(quantile([3, 1, 2, 4], 1), 4);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.ok(Math.abs(quantile([1, 2, 3, 4], 0.5) - 2.5) < 1e-9);
  const hundred = Array.from({ length: 101 }, (_, i) => i);
  assert.equal(quantile(hundred, 0.95), 95);
  assert.equal(quantile(hundred, 0.99), 99);
});

test('dailyPeaks buckets by 24 hour intervals ending at now', () => {
  const peaks = dailyPeaks(
    [
      { t: NOW - 1000, v: 5 },
      { t: NOW - DAY + 1000, v: 9 },
      { t: NOW - DAY - 1000, v: 3 },
      { t: NOW - 2 * DAY - 1000, v: 7 },
      { t: NOW - 2 * DAY - 2000, v: 8 },
      { t: NOW + 1000, v: 999 }
    ],
    NOW
  );
  assert.deepEqual(peaks, [8, 3, 9]);
});

test('roundMemory snaps to presets and then to 64 MiB steps', () => {
  assert.equal(roundMemory(64 * MiB), 64 * MiB);
  assert.equal(roundMemory(65 * MiB), 128 * MiB);
  assert.equal(roundMemory(130 * MiB), 512 * MiB);
  assert.equal(roundMemory(1024 * MiB), 1024 * MiB);
  assert.equal(roundMemory(3000 * MiB), 4096 * MiB);
  assert.equal(roundMemory(4097 * MiB), 4160 * MiB);
  assert.equal(roundMemory(4600 * MiB), 4608 * MiB);
});

test('roundCpu snaps to presets and then to 100m steps', () => {
  assert.equal(roundCpu(50), 50);
  assert.equal(roundCpu(100), 100);
  assert.equal(roundCpu(101), 250);
  assert.equal(roundCpu(690), 1000);
  assert.equal(roundCpu(2000), 2000);
  assert.equal(roundCpu(2001), 2100);
  assert.equal(roundCpu(2240), 2300);
});

test('formatters print MB, GB, millicores and CPUs', () => {
  assert.equal(formatBytes(410 * MiB), '410 MB');
  assert.equal(formatBytes(1024 * MiB), '1 GB');
  assert.equal(formatBytes(1536 * MiB), '1.5 GB');
  assert.equal(formatCpu(250), '250m');
  assert.equal(formatCpu(1000), '1 CPU');
  assert.equal(formatCpu(1500), '1.5 CPU');
});

test('less than 3 days of history is insufficient', () => {
  const result = recommendResources(
    input({ samples: samples(2), current: { cpuLimitMilli: 2000, memoryBytes: 4096 * MiB } })
  );
  assert.equal(result.status, 'insufficient');
  assert.equal(result.reason, NOT_ENOUGH_HISTORY_REASON);
  assert.equal(result.reason, 'Not enough history yet (needs 3 days).');
  assert.equal(result.confidence, null);
  assert.ok(result.historyDays < 3);
  assert.equal(result.memory.change, 'none');
  assert.equal(result.memory.recommended, 4096 * MiB);
  assert.equal(result.cpu.change, 'none');
  assert.equal(result.cpu.recommended, 2000);
  assert.equal(result.freedPerMonth, undefined);
});

test('no samples at all is insufficient', () => {
  const result = recommendResources(input({ samples: [] }));
  assert.equal(result.status, 'insufficient');
  assert.equal(result.historyDays, 0);
  assert.equal(result.memory.peak, 0);
});

test('exactly 3 days of 5 minute samples is enough', () => {
  const result = recommendResources(input({ samples: samples(3) }));
  assert.equal(result.status, 'ok');
  assert.equal(result.historyDays, 3);
  assert.equal(result.confidence, 'medium');
});

test('memory peak plus 15% rounds up to the next preset', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: (i) => (i === 500 ? 410 * MiB : 200 * MiB) }),
      current: { cpuLimitMilli: 250, memoryBytes: 2048 * MiB }
    })
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.memory.peak, 410 * MiB);
  assert.equal(result.memory.recommended, 512 * MiB);
  assert.equal(result.memory.change, 'lower');
  assert.equal(result.memory.reason, 'Peak was 410 MB over 14 days.');
  assertPlainReason(result.memory.reason);
});

test('memory above the preset range rounds to 64 MiB steps', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 4000 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 2048 * MiB }
    })
  );
  assert.equal(result.memory.recommended, 4608 * MiB);
  assert.equal(result.memory.change, 'raise');
  assert.equal(result.memory.reason, 'Peak was 3.91 GB over 14 days.');
});

test('an OOM kill bumps memory by at least 20% or 100 MiB', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 300 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 512 * MiB },
      oomKilled: true
    })
  );
  assert.equal(result.memory.recommended, 1024 * MiB);
  assert.equal(result.memory.change, 'raise');
  assert.equal(
    result.memory.reason,
    'Out of memory in the last 14 days, so memory goes up by at least 20%.'
  );
  assertPlainReason(result.memory.reason);
});

test('an OOM kill above the presets uses the 20% bump rounded to 64 MiB', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 1000 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 4096 * MiB },
      oomKilled: true
    })
  );
  assert.equal(result.memory.recommended, 4928 * MiB);
  assert.equal(result.memory.change, 'raise');
});

test('an OOM kill raises memory even after a restart in the last 24 hours', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 300 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 512 * MiB },
      oomKilled: true,
      restartsLast24h: 3,
      restartsInWindow: 3
    })
  );
  assert.equal(result.memory.change, 'raise');
  assert.equal(result.memory.recommended, 1024 * MiB);
});

test('a database image keeps its memory floor', () => {
  const result = recommendResources(
    input({
      image: 'postgres:16',
      samples: samples(14, { memory: () => 100 * MiB }),
      current: { cpuLimitMilli: 500, memoryBytes: 2048 * MiB }
    })
  );
  assert.equal(result.memory.recommended, 512 * MiB);
  assert.equal(result.memory.change, 'lower');
  assert.equal(
    result.memory.reason,
    'Peak was 100 MB over 14 days; this image needs at least 256 MB.'
  );
  assertPlainReason(result.memory.reason);
});

test('a regular image falls to the 128 MiB floor', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 20 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 1024 * MiB }
    })
  );
  assert.equal(result.memory.recommended, 128 * MiB);
  assert.equal(result.memory.change, 'lower');
  assert.equal(result.memory.reason, 'Peak was 20 MB over 14 days.');
});

test('cpu limit follows p95 times 1.5 when usage is steady', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: () => 200 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.p95, 200);
  assert.equal(result.cpu.p99, 200);
  assert.equal(result.cpu.recommended, 500);
  assert.equal(result.cpu.change, 'lower');
  assert.equal(result.cpu.throttledP95, null);
  assert.equal(result.cpu.reason, 'Usage was 200m at p95 and 200m at p99 over 14 days.');
  assertPlainReason(result.cpu.reason);
});

test('cpu limit follows p99 times 1.15 when usage spikes', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: (i) => (i < 50 ? 600 : 100) }),
      current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.p95, 100);
  assert.equal(result.cpu.p99, 600);
  assert.equal(result.cpu.recommended, 1000);
  assert.equal(result.cpu.change, 'lower');
});

test('cpu never drops below 100m', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: () => 10 }),
      current: { cpuLimitMilli: 1000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.recommended, 100);
  assert.equal(result.cpu.change, 'lower');
});

test('throttling raises the cpu limit by the throttled share', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: () => 100, throttle: () => 40 }),
      current: { cpuLimitMilli: 500, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.throttledP95, 40);
  assert.equal(result.cpu.recommended, 1000);
  assert.equal(result.cpu.change, 'raise');
  assert.equal(
    result.cpu.reason,
    'Throttled 40% of the time at p95; the CPU limit is the bottleneck.'
  );
  assertPlainReason(result.cpu.reason);
});

test('throttling above 10% prevents lowering cpu even with low usage', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: () => 50, throttle: () => 12 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.change, 'none');
  assert.equal(result.cpu.recommended, 2000);
});

test('throttling at or below 10% does not block lowering', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { cpu: () => 50, throttle: () => 5 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.cpu.throttledP95, 5);
  assert.equal(result.cpu.change, 'lower');
  assert.equal(result.cpu.recommended, 100);
});

test('memory changes need 25% and 128 MiB', () => {
  const smallAbsolute = recommendResources(
    input({
      samples: samples(14, { memory: () => 20 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 200 * MiB }
    })
  );
  assert.equal(smallAbsolute.memory.change, 'none');
  assert.equal(smallAbsolute.memory.recommended, 200 * MiB);

  const smallRatio = recommendResources(
    input({
      samples: samples(14, { memory: () => 3950 * MiB }),
      current: { cpuLimitMilli: 250, memoryBytes: 4096 * MiB }
    })
  );
  assert.equal(smallRatio.memory.change, 'none');
  assert.equal(smallRatio.memory.recommended, 4096 * MiB);
});

test('cpu changes need 25% and 100m', () => {
  const smallAbsolute = recommendResources(
    input({
      samples: samples(14, { cpu: () => 50 }),
      current: { cpuLimitMilli: 150, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(smallAbsolute.cpu.change, 'none');
  assert.equal(smallAbsolute.cpu.recommended, 150);

  const smallRatio = recommendResources(
    input({
      samples: samples(14, { cpu: () => 1100 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(smallRatio.cpu.change, 'none');
  assert.equal(smallRatio.cpu.recommended, 2000);

  const both = recommendResources(
    input({
      samples: samples(14, { cpu: () => 50 }),
      current: { cpuLimitMilli: 200, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(both.cpu.change, 'lower');
  assert.equal(both.cpu.recommended, 100);
});

test('a restart in the last 24 hours blocks lowering', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 100 * MiB, cpu: () => 50 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 2048 * MiB },
      restartsLast24h: 1,
      restartsInWindow: 1
    })
  );
  assert.equal(result.memory.change, 'none');
  assert.equal(result.memory.recommended, 2048 * MiB);
  assert.equal(result.cpu.change, 'none');
  assert.equal(result.cpu.recommended, 2000);
  assert.match(result.memory.reason, /restarted in the last 24 hours/);
  assert.match(result.cpu.reason, /restarted in the last 24 hours/);
  assertPlainReason(result.memory.reason);
  assertPlainReason(result.cpu.reason);
  assert.equal(result.freedPerMonth, undefined);
});

test('a restart in the last 24 hours still allows raising', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 900 * MiB, cpu: () => 600 }),
      current: { cpuLimitMilli: 250, memoryBytes: 512 * MiB },
      restartsLast24h: 1,
      restartsInWindow: 1
    })
  );
  assert.equal(result.memory.change, 'raise');
  assert.equal(result.memory.recommended, 2048 * MiB);
  assert.equal(result.cpu.change, 'raise');
  assert.equal(result.cpu.recommended, 1000);
});

test('confidence depends on history length and restarts', () => {
  assert.equal(recommendResources(input({ samples: samples(14) })).confidence, 'high');
  assert.equal(recommendResources(input({ samples: samples(7) })).confidence, 'high');
  assert.equal(recommendResources(input({ samples: samples(5) })).confidence, 'medium');
  assert.equal(recommendResources(input({ samples: samples(3) })).confidence, 'medium');
  assert.equal(
    recommendResources(input({ samples: samples(14), restartsInWindow: 2 })).confidence,
    'medium'
  );
  assert.equal(recommendResources(input({ samples: samples(2) })).confidence, null);
});

test('samples older than 14 days are ignored', () => {
  const old = samples(20, { memory: (_i, t) => (t < NOW - 15 * DAY ? 3000 * MiB : 300 * MiB) });
  const result = recommendResources(
    input({ samples: old, current: { cpuLimitMilli: 250, memoryBytes: 2048 * MiB } })
  );
  assert.equal(result.historyDays, 14);
  assert.equal(result.memory.peak, 300 * MiB);
  assert.equal(result.memory.recommended, 512 * MiB);
  assert.equal(result.memory.reason, 'Peak was 300 MB over 14 days.');
});

test('samples only older than 14 days are insufficient', () => {
  const stale = samples(20).filter((s) => s.t < NOW - 15 * DAY);
  const result = recommendResources(input({ samples: stale }));
  assert.equal(result.status, 'insufficient');
});

test('freedPerMonth reports the reserved cpu and memory that a lowering frees', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 300 * MiB, cpu: () => 200 }),
      current: { cpuLimitMilli: 2000, memoryBytes: 2048 * MiB }
    })
  );
  assert.equal(result.memory.recommended, 512 * MiB);
  assert.equal(result.cpu.recommended, 500);
  assert.deepEqual(result.freedPerMonth, { cpuMilli: 150, memoryBytes: 1536 * MiB });
});

test('no freedPerMonth when nothing is lowered', () => {
  const result = recommendResources(
    input({
      samples: samples(14, { memory: () => 300 * MiB, cpu: () => 100 }),
      current: { cpuLimitMilli: 250, memoryBytes: 512 * MiB }
    })
  );
  assert.equal(result.memory.change, 'none');
  assert.equal(result.cpu.change, 'none');
  assert.equal(result.freedPerMonth, undefined);
});

test('missing throttle samples report null and missing cpu values are skipped', () => {
  const mixed = samples(14, { cpu: () => 200 }).map((s, i) =>
    i % 2 === 0 ? { ...s, cpuMilli: null } : s
  );
  const result = recommendResources(
    input({ samples: mixed, current: { cpuLimitMilli: 2000, memoryBytes: 512 * MiB } })
  );
  assert.equal(result.cpu.throttledP95, null);
  assert.equal(result.cpu.p95, 200);
});
