import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastMemoryLimit,
  linearFit,
  projection,
  type ForecastPoint
} from '../src/metrics/forecast';

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const STEP = 5 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function series(hours: number, value: (t: number, i: number) => number): ForecastPoint[] {
  const out: ForecastPoint[] = [];
  const count = Math.floor((hours * HOUR) / STEP);
  for (let i = count; i >= 0; i--) {
    const t = NOW - i * STEP;
    out.push({ t, v: value(t, count - i) });
  }
  return out;
}

function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
}

const leak = (t: number) => 500 * MiB + ((t - (NOW - 6 * HOUR)) / HOUR) * 10 * MiB;

test('linearFit recovers an exact line', () => {
  const points = [0, 1, 2, 3, 4].map((x) => ({ t: x * 1000, v: 3 * x * 1000 + 7 }));
  const fit = linearFit(points);
  assert.ok(Math.abs(fit.slope - 3) < 1e-9);
  assert.ok(Math.abs(fit.intercept - 7) < 1e-6);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
});

test('linearFit on a flat series has zero slope and zero r2', () => {
  const fit = linearFit(series(6, () => 100 * MiB));
  assert.equal(fit.slope, 0);
  assert.equal(fit.r2, 0);
  assert.equal(fit.intercept, 100 * MiB);
});

test('linearFit handles empty and single point input', () => {
  assert.deepEqual(linearFit([]), { slope: 0, intercept: 0, r2: 0 });
  assert.deepEqual(linearFit([{ t: 5, v: 9 }]), { slope: 0, intercept: 9, r2: 0 });
});

test('a steady leak forecasts the crossing time', () => {
  const points = series(6, leak);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.ok(forecast);
  assert.ok(Math.abs(forecast.hitsLimitAt - (NOW + 10 * HOUR)) < 60 * 1000);
  assert.ok(Math.abs(forecast.slopeBytesPerHour - 10 * MiB) < 1);
  assert.ok(forecast.confidence > 0.999);
});

test('a leak with mild noise still forecasts', () => {
  const rand = noise(7);
  const points = series(6, (t) => leak(t) + rand() * 4 * MiB);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.ok(forecast);
  assert.ok(Math.abs(forecast.hitsLimitAt - (NOW + 10 * HOUR)) < HOUR);
  assert.ok(forecast.confidence >= 0.8);
});

test('a noisy flat series gives no forecast', () => {
  const rand = noise(42);
  const points = series(6, () => 500 * MiB + rand() * 40 * MiB);
  assert.ok(linearFit(points).r2 < 0.8);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 520 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('r2 below 0.8 gives no forecast even with a rising trend', () => {
  const rand = noise(3);
  const points = series(6, (t) => leak(t) + rand() * 120 * MiB);
  const fit = linearFit(points);
  assert.ok(fit.slope > 0);
  assert.ok(fit.r2 < 0.8);
  assert.ok(fit.r2 > 0.1);
  const crossing = (660 * MiB - fit.intercept) / fit.slope;
  assert.ok(crossing > NOW && crossing < NOW + 24 * HOUR);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('a pod younger than 6 hours gives no forecast', () => {
  const forecast = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 2 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('too few points gives no forecast', () => {
  const points = series(6, leak).slice(-10);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('a crossing beyond 24 hours gives no forecast', () => {
  const forecast = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 860 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('a crossing just inside 24 hours forecasts', () => {
  const forecast = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 790 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.ok(forecast);
  assert.ok(Math.abs(forecast.hitsLimitAt - (NOW + 23 * HOUR)) < 60 * 1000);
});

test('a negative slope gives no forecast', () => {
  const points = series(6, (t) => 900 * MiB - ((t - (NOW - 6 * HOUR)) / HOUR) * 10 * MiB);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 1024 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('a value already at or over the limit gives no forecast', () => {
  const forecast = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 560 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
  const over = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 540 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(over, null);
});

test('a zero limit gives no forecast', () => {
  const forecast = forecastMemoryLimit({
    points: series(6, leak),
    limitBytes: 0,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.equal(forecast, null);
});

test('projection runs from the last point to the crossing', () => {
  const points = series(6, leak);
  const fit = linearFit(points);
  const forecast = forecastMemoryLimit({
    points,
    limitBytes: 660 * MiB,
    podStartedAt: NOW - 8 * HOUR,
    now: NOW
  });
  assert.ok(forecast);
  const line = projection(points, fit, forecast.hitsLimitAt);
  assert.equal(line.length, 2);
  assert.equal(line[0].t, NOW);
  assert.ok(Math.abs(line[0].v - 560 * MiB) < 1);
  assert.equal(line[1].t, forecast.hitsLimitAt);
  assert.ok(Math.abs(line[1].v - 660 * MiB) < 1024);
});

test('projection of no points is empty', () => {
  assert.deepEqual(projection([], { slope: 1, intercept: 0, r2: 1 }, NOW), []);
});
