import type { Symptom, SymptomKind } from './correlate';

export interface Point {
  x: number;
  y: number;
}

export interface SymptomSeries {
  errorPct?: Point[];
  p95Ms?: Point[];
  memoryBytes?: Point[];
  throttledPct?: Point[];
  restarts?: Point[];
}

const LOOKBACK_MS = 30 * 60_000;
const MIB = 1024 * 1024;

const FLOORS: Record<'errorPct' | 'p95Ms' | 'throttledPct', { abs: number; rel: number }> = {
  errorPct: { abs: 1, rel: 1 },
  p95Ms: { abs: 100, rel: 0.5 },
  throttledPct: { abs: 25, rel: 0 }
};

const KINDS: Record<'errorPct' | 'p95Ms' | 'throttledPct', SymptomKind> = {
  errorPct: 'error-rate',
  p95Ms: 'p95',
  throttledPct: 'throttling'
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

function clean(points: Point[] | undefined): Point[] {
  return (points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

export function episodes(points: Point[], threshold: number, minRun = 2) {
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= points.length; i++) {
    const above = i < points.length && points[i].y > threshold;
    if (above && start < 0) start = i;
    if (!above && start >= 0) {
      if (i - start >= minRun) out.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return out;
}

function thresholdSymptoms(key: 'errorPct' | 'p95Ms' | 'throttledPct', points: Point[]): Symptom[] {
  if (points.length < 6) return [];
  const floor = FLOORS[key];
  const usual = median(points.map((p) => p.y));
  const threshold =
    key === 'throttledPct' ? floor.abs : Math.max(usual + floor.abs, usual * (1 + floor.rel));
  const runs = episodes(points, threshold);
  return runs.map((run, i) => {
    const onset = points[run.start].x;
    const prior = points.filter((p) => p.x < onset && p.x >= onset - LOOKBACK_MS).map((p) => p.y);
    const during = points.slice(run.start, run.end + 1).map((p) => p.y);
    const previous = runs[i - 1];
    const presentBefore =
      (previous && points[previous.end].x >= onset - LOOKBACK_MS) ||
      (run.start === 0 && points[0].y > threshold);
    const open = run.end === points.length - 1;
    return {
      id: `${KINDS[key]}:${onset}`,
      kind: KINDS[key],
      onset,
      end: open ? null : points[run.end].x,
      before: prior.length ? median(prior) : usual,
      after: key === 'throttledPct' ? mean(during) : Math.max(...during),
      presentBefore: Boolean(presentBefore)
    };
  });
}

export function memoryStep(points: Point[]): Symptom[] {
  if (points.length < 12) return [];
  const ys = points.map((p) => p.y);
  const w = Math.max(4, Math.floor(ys.length / 6));
  let best = { i: -1, diff: 0, before: 0, after: 0 };
  for (let i = w; i <= ys.length - w; i++) {
    const before = mean(ys.slice(Math.max(0, i - w), i));
    const after = mean(ys.slice(i, i + w));
    if (after - before > best.diff) best = { i, diff: after - before, before, after };
  }
  if (best.i < 0) return [];
  if (best.diff < 64 * MIB || best.after < best.before * 1.3) return [];
  const onset = points[best.i].x;
  return [
    {
      id: `memory-step:${onset}`,
      kind: 'memory-step',
      onset,
      end: null,
      before: best.before,
      after: best.after,
      presentBefore: false
    }
  ];
}

export function restartBursts(points: Point[], windowMs = 10 * 60_000, min = 3): Symptom[] {
  const out: Symptom[] = [];
  const events = points.filter((p) => p.y > 0);
  let i = 0;
  while (i < events.length) {
    let total = 0;
    let j = i;
    while (j < events.length && events[j].x - events[i].x <= windowMs) {
      total += events[j].y;
      j++;
    }
    if (total >= min) {
      const onset = events[i].x;
      const prior = out[out.length - 1];
      out.push({
        id: `restart-burst:${onset}`,
        kind: 'restart-burst',
        onset,
        end: events[j - 1].x,
        before: 0,
        after: total,
        presentBefore: !!prior && (prior.end ?? prior.onset) >= onset - LOOKBACK_MS
      });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export function detectSymptoms(series: SymptomSeries): Symptom[] {
  return [
    ...thresholdSymptoms('errorPct', clean(series.errorPct)),
    ...thresholdSymptoms('p95Ms', clean(series.p95Ms)),
    ...thresholdSymptoms('throttledPct', clean(series.throttledPct)),
    ...memoryStep(clean(series.memoryBytes)),
    ...restartBursts(clean(series.restarts))
  ].sort((a, b) => a.onset - b.onset);
}
