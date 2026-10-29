export type SymptomKind = 'error-rate' | 'p95' | 'memory-step' | 'restart-burst' | 'throttling';

export type ChangeKind =
  | 'deploy'
  | 'config'
  | 'resources'
  | 'env'
  | 'scale'
  | 'platform'
  | 'eviction'
  | 'node'
  | 'database';

export interface Symptom {
  id: string;
  kind: SymptomKind;
  onset: number;
  end?: number | null;
  before: number;
  after: number;
  presentBefore: boolean;
}

export interface Change {
  id: string;
  t: number;
  kind: ChangeKind;
  label: string;
  phrase?: string;
  actor?: string | null;
}

export interface Finding {
  symptomId: string;
  causeId: string | null;
  sentence: string;
  evidence: string[];
  at: number;
}

export interface CorrelateInput {
  symptoms: Symptom[];
  changes: Change[];
  dependencies?: Change[];
  formatTime: (ms: number) => string;
}

export const LINK_WINDOW_MS = 10 * 60_000;

export const STRONG_WITHOUT_CAUSE = {
  errorRatePct: 5,
  errorRateRisePoints: 2,
  p95RiseMs: 500,
  p95Ratio: 2,
  memoryRiseBytes: 256 * 1024 ** 2,
  memoryRatio: 1.5,
  restarts: 3,
  throttledPct: 25
} as const;

const CAUSE_RANK: Record<ChangeKind, number> = {
  deploy: 0,
  resources: 1,
  env: 2,
  config: 3,
  scale: 4,
  database: 5,
  platform: 6,
  eviction: 6,
  node: 6
};

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten'
];

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function trimZero(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

export function formatPercent(v: number): string {
  if (v > 0 && v < 0.1) return `${trimZero(v.toFixed(2))}%`;
  return `${trimZero(v.toFixed(1))}%`;
}

export function formatMs(v: number): string {
  if (v >= 1000) return `${trimZero((v / 1000).toFixed(1))} s`;
  return `${Math.round(v)} ms`;
}

export function formatBytes(v: number): string {
  if (v >= GIB) return `${trimZero((v / GIB).toFixed(v >= 10 * GIB ? 0 : 1))} GiB`;
  return `${Math.round(v / MIB)} MiB`;
}

export function minutesAfter(deltaMs: number): string {
  if (deltaMs < 60_000) return 'right after';
  const m = Math.min(10, Math.max(1, Math.round(deltaMs / 60_000)));
  if (m === 1) return 'a minute after';
  return `${NUMBER_WORDS[m]} minutes after`;
}

function withThe(label: string): string {
  return /^(the|a|an)\s/i.test(label) ? label : `the ${label}`;
}

export function causePhrase(c: Change): string {
  if (c.phrase) return c.phrase;
  switch (c.kind) {
    case 'deploy':
      return `${c.label} went live`;
    case 'resources':
      return `${withThe(c.label)} changed`;
    case 'env':
    case 'config':
      return `${c.label} changed`;
    case 'scale':
      return `the app was scaled to ${c.label}`;
    case 'database':
      return `${withThe(c.label)} restarted`;
    case 'platform':
      return `${withThe(c.label)} rolled out`;
    case 'eviction':
      return `${withThe(c.label)} was evicted`;
    case 'node':
      return `${withThe(c.label)} was drained`;
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function observation(s: Symptom, formatTime: (ms: number) => string): string {
  const at = formatTime(s.onset);
  const ended = s.end != null && Number.isFinite(s.end) ? formatTime(s.end) : null;
  switch (s.kind) {
    case 'error-rate':
      return `Errors ${s.after >= s.before ? 'went' : 'fell'} from ${formatPercent(s.before)} to ${formatPercent(s.after)} at ${at}`;
    case 'p95':
      return `Responses ${s.after >= s.before ? 'slowed' : 'sped up'} from ${formatMs(s.before)} to ${formatMs(s.after)} at ${at}`;
    case 'memory-step':
      return `Memory ${s.after >= s.before ? 'stepped up' : 'dropped'} from ${formatBytes(s.before)} to ${formatBytes(s.after)} at ${at}`;
    case 'restart-burst': {
      const n = Math.round(s.after);
      const times = plural(n, 'once', `${n} times`);
      return ended
        ? `Restarted ${times} between ${at} and ${ended}`
        : `Restarted ${times} from ${at}`;
    }
    case 'throttling': {
      const pct = `${Math.round(s.after)}%`;
      return ended
        ? `Throttled ${pct} of the time from ${at} to ${ended}`
        : `Throttled ${pct} of the time since ${at}`;
    }
  }
}

export function isStrong(s: Symptom): boolean {
  const t = STRONG_WITHOUT_CAUSE;
  switch (s.kind) {
    case 'error-rate':
      return s.after >= t.errorRatePct && s.after - s.before >= t.errorRateRisePoints;
    case 'p95':
      return s.after - s.before >= t.p95RiseMs && s.after >= s.before * t.p95Ratio;
    case 'memory-step':
      return s.after - s.before >= t.memoryRiseBytes && s.after >= s.before * t.memoryRatio;
    case 'restart-burst':
      return s.after >= t.restarts;
    case 'throttling':
      return s.after >= t.throttledPct;
  }
}

export function pickCause(s: Symptom, candidates: Change[]): Change | null {
  if (s.presentBefore) return null;
  let best: Change | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    if (!Number.isFinite(c.t)) continue;
    const gap = s.onset - c.t;
    if (gap < 0 || gap > LINK_WINDOW_MS) continue;
    if (
      !best ||
      gap < bestGap ||
      (gap === bestGap && CAUSE_RANK[c.kind] < CAUSE_RANK[best.kind]) ||
      (gap === bestGap && CAUSE_RANK[c.kind] === CAUSE_RANK[best.kind] && c.id < best.id)
    ) {
      best = c;
      bestGap = gap;
    }
  }
  return best;
}

function valid(s: Symptom): boolean {
  return Number.isFinite(s.onset) && Number.isFinite(s.before) && Number.isFinite(s.after);
}

export function describeSymptom(
  s: Symptom,
  cause: Change | null,
  formatTime: (ms: number) => string
): string {
  const seen = observation(s, formatTime);
  if (cause) return `${seen}, ${minutesAfter(s.onset - cause.t)} ${causePhrase(cause)}.`;
  if (s.kind === 'throttling' && s.end == null) return `${seen}; the CPU limit is the bottleneck.`;
  return `${seen}.`;
}

export function correlate(input: CorrelateInput): Finding[] {
  const candidates = [...input.changes, ...(input.dependencies ?? [])];
  const out: Finding[] = [];
  for (const s of input.symptoms) {
    if (!valid(s)) continue;
    const cause = pickCause(s, candidates);
    if (!cause && !isStrong(s)) continue;
    out.push({
      symptomId: s.id,
      causeId: cause?.id ?? null,
      sentence: describeSymptom(s, cause, input.formatTime),
      evidence: cause ? [s.id, cause.id] : [s.id],
      at: s.onset
    });
  }
  return out.sort((a, b) => a.at - b.at || (a.symptomId < b.symptomId ? -1 : 1));
}
