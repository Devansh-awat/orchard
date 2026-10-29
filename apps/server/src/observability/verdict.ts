export interface VerdictWindow {
  requests: number;
  errorPct: number | null;
  p95Ms: number | null;
  rps: number | null;
  memoryBytes: number | null;
  restarts: number;
}

export interface VerdictInput {
  before: VerdictWindow;
  after: VerdictWindow;
  newErrorGroups: number;
  version: string | null;
  previousVersion: string | null;
}

export type VerdictStatus = 'regressed' | 'improved' | 'unchanged' | 'insufficient';

export type VerdictDimension = 'p95' | 'errors' | 'restarts' | 'memory';

export type LineStatus = VerdictStatus | 'notable';

export interface VerdictLine {
  dimension: VerdictDimension;
  status: LineStatus;
  before: number | null;
  after: number | null;
  text: string;
}

export interface DeployVerdict {
  status: VerdictStatus;
  summary: string;
  lines: VerdictLine[];
  newErrorGroups: number;
}

export const VERDICT_FLOORS = {
  minRequests: 200,
  p95Ratio: 0.25,
  p95Ms: 50,
  errorRatio: 2,
  errorPoints: 0.5,
  restarts: 2,
  memoryRatio: 0.3,
  memoryBytes: 64 * 1024 ** 2
} as const;

const EPS = 1e-9;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function trimZero(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function pct(v: number): string {
  if (v > 0 && v < 0.1) return `${trimZero(v.toFixed(2))}%`;
  return `${trimZero(v.toFixed(1))}%`;
}

function msRange(a: number, b: number): string {
  if (a < 1000 && b < 1000) return `${Math.round(a)} → ${Math.round(b)} ms`;
  if (a >= 1000 && b >= 1000)
    return `${trimZero((a / 1000).toFixed(1))} → ${trimZero((b / 1000).toFixed(1))} s`;
  const one = (v: number) =>
    v >= 1000 ? `${trimZero((v / 1000).toFixed(1))} s` : `${Math.round(v)} ms`;
  return `${one(a)} → ${one(b)}`;
}

function bytesRange(a: number, b: number): string {
  if (a >= GIB || b >= GIB)
    return `${trimZero((a / GIB).toFixed(1))} → ${trimZero((b / GIB).toFixed(1))} GiB`;
  return `${Math.round(a / MIB)} → ${Math.round(b / MIB)} MiB`;
}

function relative(before: number, after: number): number | null {
  if (before <= 0) return null;
  return Math.round((Math.abs(after - before) / before) * 100);
}

function enoughTraffic(input: VerdictInput): boolean {
  return (
    input.before.requests >= VERDICT_FLOORS.minRequests &&
    input.after.requests >= VERDICT_FLOORS.minRequests
  );
}

function than(prev: string | null): string {
  return prev ? ` than ${prev}` : '';
}

function times(n: number): string {
  return n === 1 ? 'once' : `${n} times`;
}

function p95Line(input: VerdictInput): VerdictLine {
  const before = input.before.p95Ms;
  const after = input.after.p95Ms;
  const base = { dimension: 'p95' as const, before, after };
  if (before == null || after == null || !enoughTraffic(input)) {
    return {
      ...base,
      status: 'insufficient',
      text: 'Not enough traffic to compare response times'
    };
  }
  const delta = after - before;
  const range = msRange(before, after);
  const rel = relative(before, after);
  const amount = rel == null ? '' : `${rel}% `;
  if (delta + EPS >= before * VERDICT_FLOORS.p95Ratio && delta + EPS >= VERDICT_FLOORS.p95Ms) {
    return {
      ...base,
      status: 'regressed',
      text: `Responses ${amount}slower${than(input.previousVersion)} (p95 ${range})`
    };
  }
  if (-delta + EPS >= before * VERDICT_FLOORS.p95Ratio && -delta + EPS >= VERDICT_FLOORS.p95Ms) {
    return {
      ...base,
      status: 'improved',
      text: `Responses ${amount}faster${than(input.previousVersion)} (p95 ${range})`
    };
  }
  return { ...base, status: 'unchanged', text: `Response times unchanged (p95 ${range})` };
}

function errorsLine(input: VerdictInput): VerdictLine {
  const before = input.before.errorPct;
  const after = input.after.errorPct;
  const base = { dimension: 'errors' as const, before, after };
  if (before == null || after == null || !enoughTraffic(input)) {
    return { ...base, status: 'insufficient', text: 'Not enough traffic to compare errors' };
  }
  const delta = after - before;
  if (
    after + EPS >= before * VERDICT_FLOORS.errorRatio &&
    delta + EPS >= VERDICT_FLOORS.errorPoints
  ) {
    return {
      ...base,
      status: 'regressed',
      text: `Errors went from ${pct(before)} to ${pct(after)}`
    };
  }
  if (
    after * VERDICT_FLOORS.errorRatio <= before + EPS &&
    -delta + EPS >= VERDICT_FLOORS.errorPoints
  ) {
    return {
      ...base,
      status: 'improved',
      text: `Errors fell from ${pct(before)} to ${pct(after)}`
    };
  }
  return { ...base, status: 'unchanged', text: `Errors unchanged at ${pct(after)}` };
}

function restartsLine(input: VerdictInput): VerdictLine {
  const before = input.before.restarts;
  const after = input.after.restarts;
  const base = { dimension: 'restarts' as const, before, after };
  if (after > before && after >= VERDICT_FLOORS.restarts) {
    return { ...base, status: 'regressed', text: `Restarted ${times(after)}, up from ${before}` };
  }
  const now = after === 0 ? 'No restarts' : `Restarted ${times(after)}`;
  let text = now;
  if (after > before) text = `${now}, up from ${before}`;
  else if (after < before) text = `${now}, down from ${before}`;
  else if (after > 0) text = `${now}, same as before`;
  return { ...base, status: 'unchanged', text };
}

function memoryLine(input: VerdictInput): VerdictLine {
  const before = input.before.memoryBytes;
  const after = input.after.memoryBytes;
  const base = { dimension: 'memory' as const, before, after };
  if (before == null || after == null) {
    return { ...base, status: 'insufficient', text: 'No memory readings to compare' };
  }
  const delta = after - before;
  const range = bytesRange(before, after);
  const rel = relative(before, after);
  const amount = rel == null ? '' : ` ${rel}%`;
  const big = Math.abs(delta) + EPS >= VERDICT_FLOORS.memoryBytes;
  if (big && delta > 0 && delta + EPS >= before * VERDICT_FLOORS.memoryRatio) {
    return { ...base, status: 'notable', text: `Memory up${amount} (${range})` };
  }
  if (big && delta < 0 && -delta + EPS >= before * VERDICT_FLOORS.memoryRatio) {
    return { ...base, status: 'notable', text: `Memory down${amount} (${range})` };
  }
  return { ...base, status: 'unchanged', text: `Memory unchanged (${range})` };
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function shortText(line: VerdictLine): string {
  if (line.dimension === 'p95' && line.before != null && line.after != null) {
    const rel = relative(line.before, line.after);
    const word = line.status === 'regressed' ? 'slower' : 'faster';
    return `responses ${rel == null ? '' : `${rel}% `}${word} (p95 ${msRange(line.before, line.after)})`;
  }
  return lower(line.text);
}

export function deployVerdict(input: VerdictInput): DeployVerdict {
  const p95 = p95Line(input);
  const errors = errorsLine(input);
  const restarts = restartsLine(input);
  const memory = memoryLine(input);
  const lines = [p95, errors, restarts, memory];
  const newErrorGroups = Math.max(0, Math.round(input.newErrorGroups || 0));

  let status: VerdictStatus;
  if (lines.some((l) => l.status === 'regressed')) status = 'regressed';
  else if (lines.some((l) => l.status === 'improved')) status = 'improved';
  else if (p95.status === 'insufficient' && errors.status === 'insufficient')
    status = 'insufficient';
  else status = 'unchanged';

  const parts: string[] = [];
  for (const l of lines) {
    if (l.status === 'regressed' || l.status === 'improved' || l.status === 'notable')
      parts.push(shortText(l));
  }

  const moved = (l: VerdictLine) => l.status === 'regressed' || l.status === 'improved';
  if (moved(p95) && errors.status === 'unchanged') parts.push('errors unchanged');
  if (moved(errors) && p95.status === 'unchanged') parts.push('responses unchanged');
  if (newErrorGroups > 0)
    parts.push(`${newErrorGroups} new ${newErrorGroups === 1 ? 'error' : 'errors'}`);

  const name = input.version || 'This deploy';
  let summary: string;
  if (status === 'insufficient' && parts.length === 0)
    summary = `${name}: not enough traffic to compare`;
  else if (parts.length === 0) summary = 'No change worth noting';
  else summary = `${name}: ${parts.join('; ')}`;

  return { status, summary, lines, newErrorGroups };
}
