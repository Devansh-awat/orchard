import { RESOURCE_PRESETS, minPodMemoryBytesForImage } from '../kubernetes/presets';
import { cpuRequestFromLimitMilli } from '../kubernetes/quantity';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;

export const MIN_HISTORY_DAYS = 3;
export const HIGH_CONFIDENCE_DAYS = 7;
export const MAX_HISTORY_DAYS = 14;
export const MEMORY_HEADROOM = 1.15;
export const OOM_RATIO = 1.2;
export const OOM_MIN_BUMP_BYTES = 100 * MiB;
export const MEMORY_FLOOR_BYTES = 128 * MiB;
export const MEMORY_STEP_BYTES = 64 * MiB;
export const CPU_P99_HEADROOM = 1.15;
export const CPU_P95_HEADROOM = 1.5;
export const CPU_FLOOR_MILLI = 100;
export const CPU_STEP_MILLI = 100;
export const THROTTLE_THRESHOLD_PERCENT = 10;
export const CHANGE_MIN_RATIO = 0.25;
export const MEMORY_CHANGE_MIN_BYTES = 128 * MiB;
export const CPU_CHANGE_MIN_MILLI = 100;
export const NOT_ENOUGH_HISTORY_REASON = 'Not enough history yet (needs 3 days).';

export interface RightsizingSample {
  t: number;
  memoryBytes?: number | null;
  cpuMilli?: number | null;
  throttledPercent?: number | null;
}

export interface RightsizingInput {
  samples: RightsizingSample[];
  current: { cpuLimitMilli: number; memoryBytes: number };
  image: string | null;
  oomKilled: boolean;
  restartsLast24h: number;
  restartsInWindow: number;
  now: number;
}

export type ResourceChange = 'raise' | 'lower' | 'none';
export type RecommendationConfidence = 'high' | 'medium' | null;

export interface MemoryRecommendation {
  current: number;
  recommended: number;
  peak: number;
  change: ResourceChange;
  reason: string;
}

export interface CpuRecommendation {
  current: number;
  recommended: number;
  p95: number;
  p99: number;
  throttledP95: number | null;
  change: ResourceChange;
  reason: string;
}

export interface RightsizingRecommendation {
  status: 'ok' | 'insufficient';
  reason: string | null;
  historyDays: number;
  confidence: RecommendationConfidence;
  memory: MemoryRecommendation;
  cpu: CpuRecommendation;
  freedPerMonth?: { cpuMilli: number; memoryBytes: number };
}

export function quantile(values: number[], q: number): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (sorted.length - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function dailyPeaks(points: { t: number; v: number }[], now: number): number[] {
  const buckets = new Map<number, number>();
  for (const { t, v } of points) {
    if (!Number.isFinite(v) || t > now) continue;
    const day = Math.floor((now - t) / DAY_MS);
    const prev = buckets.get(day);
    if (prev === undefined || v > prev) buckets.set(day, v);
  }
  return [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
}

export function roundMemory(bytes: number): number {
  const steps = RESOURCE_PRESETS.map((p) => p.memoryBytes).sort((a, b) => a - b);
  const preset = steps.find((s) => s >= bytes) ?? Infinity;
  return Math.min(preset, Math.ceil(bytes / MEMORY_STEP_BYTES) * MEMORY_STEP_BYTES);
}

export function roundCpu(milli: number): number {
  const steps = RESOURCE_PRESETS.map((p) => p.cpuMilli).sort((a, b) => a - b);
  const preset = steps.find((s) => s >= milli) ?? Infinity;
  return Math.min(preset, Math.ceil(milli / CPU_STEP_MILLI) * CPU_STEP_MILLI);
}

export function formatBytes(bytes: number): string {
  if (bytes >= GiB) return `${trimNumber(bytes / GiB)} GB`;
  return `${Math.round(bytes / MiB)} MB`;
}

export function formatCpu(milli: number): string {
  if (milli >= 1000) return `${trimNumber(milli / 1000)} CPU`;
  return `${Math.round(milli)}m`;
}

function trimNumber(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function formatDays(days: number): string {
  const whole = Math.max(1, Math.round(days));
  return whole === 1 ? '1 day' : `${whole} days`;
}

function changeFor(
  current: number,
  recommended: number,
  minAbsolute: number,
  blockLowering: boolean
): ResourceChange {
  const delta = recommended - current;
  if (Math.abs(delta) < current * CHANGE_MIN_RATIO) return 'none';
  if (Math.abs(delta) < minAbsolute) return 'none';
  if (delta < 0 && blockLowering) return 'none';
  if (delta > 0) return 'raise';
  if (delta < 0) return 'lower';
  return 'none';
}

function series(samples: RightsizingSample[], key: keyof Omit<RightsizingSample, 't'>) {
  const out: { t: number; v: number }[] = [];
  for (const s of samples) {
    const v = s[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ t: s.t, v });
  }
  return out;
}

function historyDaysOf(samples: RightsizingSample[]): number {
  if (samples.length === 0) return 0;
  let first = Infinity;
  let last = -Infinity;
  for (const s of samples) {
    if (s.t < first) first = s.t;
    if (s.t > last) last = s.t;
  }
  return Math.min(MAX_HISTORY_DAYS, (last - first + STEP_MS) / DAY_MS);
}

function confidenceFor(historyDays: number, restartsInWindow: number): RecommendationConfidence {
  if (historyDays < MIN_HISTORY_DAYS) return null;
  if (historyDays >= HIGH_CONFIDENCE_DAYS && restartsInWindow === 0) return 'high';
  return 'medium';
}

function recommendMemory(
  input: RightsizingInput,
  samples: RightsizingSample[],
  historyDays: number
): MemoryRecommendation {
  const current = input.current.memoryBytes;
  const peaks = dailyPeaks(series(samples, 'memoryBytes'), input.now);
  const peak = peaks.length > 0 ? Math.max(...peaks) : 0;
  const days = formatDays(historyDays);
  let target = peak * MEMORY_HEADROOM;
  if (input.oomKilled) {
    target = Math.max(target, current * OOM_RATIO, current + OOM_MIN_BUMP_BYTES);
  }
  const imageFloor = minPodMemoryBytesForImage(input.image);
  const floor = Math.max(MEMORY_FLOOR_BYTES, imageFloor);
  const floored = target < floor;
  const recommended = roundMemory(Math.max(target, floor));
  const blockLowering = input.restartsLast24h > 0;
  const change =
    input.oomKilled && recommended > current
      ? 'raise'
      : changeFor(current, recommended, MEMORY_CHANGE_MIN_BYTES, blockLowering);
  const loweringBlocked =
    blockLowering && changeFor(current, recommended, MEMORY_CHANGE_MIN_BYTES, false) === 'lower';
  let reason: string;
  if (input.oomKilled) {
    reason = `Out of memory in the last ${days}, so memory goes up by at least 20%.`;
  } else if (loweringBlocked) {
    reason = `Peak was ${formatBytes(peak)} over ${days}, but the app restarted in the last 24 hours, so memory stays where it is.`;
  } else if (floored && imageFloor > MEMORY_FLOOR_BYTES) {
    reason = `Peak was ${formatBytes(peak)} over ${days}; this image needs at least ${formatBytes(imageFloor)}.`;
  } else {
    reason = `Peak was ${formatBytes(peak)} over ${days}.`;
  }
  return {
    current,
    recommended: change === 'none' ? current : recommended,
    peak,
    change,
    reason
  };
}

function recommendCpu(
  input: RightsizingInput,
  samples: RightsizingSample[],
  historyDays: number
): CpuRecommendation {
  const current = input.current.cpuLimitMilli;
  const usage = series(samples, 'cpuMilli').map((p) => p.v);
  const throttle = series(samples, 'throttledPercent').map((p) => p.v);
  const p95 = quantile(usage, 0.95);
  const p99 = quantile(usage, 0.99);
  const throttledP95 = throttle.length > 0 ? quantile(throttle, 0.95) : null;
  const throttled = throttledP95 !== null && throttledP95 > THROTTLE_THRESHOLD_PERCENT;
  const days = formatDays(historyDays);
  let target = Math.max(p99 * CPU_P99_HEADROOM, p95 * CPU_P95_HEADROOM);
  if (throttled) {
    target = Math.max(target, current * (1 + throttledP95 / 100), current);
  }
  const recommended = roundCpu(Math.max(target, CPU_FLOOR_MILLI));
  const blockLowering = input.restartsLast24h > 0 || throttled;
  const change = changeFor(current, recommended, CPU_CHANGE_MIN_MILLI, blockLowering);
  const loweringBlocked =
    input.restartsLast24h > 0 &&
    changeFor(current, recommended, CPU_CHANGE_MIN_MILLI, false) === 'lower';
  const usageSentence = `Usage was ${formatCpu(p95)} at p95 and ${formatCpu(p99)} at p99 over ${days}.`;
  let reason: string;
  if (throttled) {
    reason = `Throttled ${Math.round(throttledP95)}% of the time at p95; the CPU limit is the bottleneck.`;
  } else if (loweringBlocked) {
    reason = `${usageSentence.slice(0, -1)}, but the app restarted in the last 24 hours, so the CPU limit stays where it is.`;
  } else {
    reason = usageSentence;
  }
  return {
    current,
    recommended: change === 'none' ? current : recommended,
    p95,
    p99,
    throttledP95,
    change,
    reason
  };
}

export function recommendResources(input: RightsizingInput): RightsizingRecommendation {
  const windowStart = input.now - MAX_HISTORY_DAYS * DAY_MS;
  const samples = input.samples.filter((s) => s.t >= windowStart && s.t <= input.now);
  const historyDays = historyDaysOf(samples);
  const confidence = confidenceFor(historyDays, input.restartsInWindow);
  const memory = recommendMemory(input, samples, historyDays);
  const cpu = recommendCpu(input, samples, historyDays);

  if (historyDays < MIN_HISTORY_DAYS) {
    return {
      status: 'insufficient',
      reason: NOT_ENOUGH_HISTORY_REASON,
      historyDays,
      confidence: null,
      memory: {
        ...memory,
        recommended: memory.current,
        change: 'none',
        reason: NOT_ENOUGH_HISTORY_REASON
      },
      cpu: { ...cpu, recommended: cpu.current, change: 'none', reason: NOT_ENOUGH_HISTORY_REASON }
    };
  }

  const result: RightsizingRecommendation = {
    status: 'ok',
    reason: null,
    historyDays,
    confidence,
    memory,
    cpu
  };
  const freedMemory = memory.change === 'lower' ? memory.current - memory.recommended : 0;
  const freedCpu =
    cpu.change === 'lower'
      ? Math.max(
          0,
          cpuRequestFromLimitMilli(cpu.current) - cpuRequestFromLimitMilli(cpu.recommended)
        )
      : 0;
  if (freedMemory > 0 || freedCpu > 0) {
    result.freedPerMonth = { cpuMilli: freedCpu, memoryBytes: freedMemory };
  }
  return result;
}

export function classifyFromPeaks(input: {
  cpuP95: number | null;
  cpuP99: number | null;
  memoryPeak: number | null;
  current: { cpuLimitMilli: number | null; memoryBytes: number | null };
  image: string | null;
}): 'over' | 'under' | 'ok' | 'unknown' {
  const changes: ResourceChange[] = [];
  const { cpuLimitMilli, memoryBytes } = input.current;
  if (input.memoryPeak != null && memoryBytes) {
    const floor = Math.max(MEMORY_FLOOR_BYTES, minPodMemoryBytesForImage(input.image));
    const recommended = roundMemory(Math.max(input.memoryPeak * MEMORY_HEADROOM, floor));
    changes.push(changeFor(memoryBytes, recommended, MEMORY_CHANGE_MIN_BYTES, false));
  }
  if (input.cpuP95 != null && input.cpuP99 != null && cpuLimitMilli) {
    const recommended = roundCpu(
      Math.max(input.cpuP99 * CPU_P99_HEADROOM, input.cpuP95 * CPU_P95_HEADROOM, CPU_FLOOR_MILLI)
    );
    changes.push(changeFor(cpuLimitMilli, recommended, CPU_CHANGE_MIN_MILLI, false));
  }
  if (changes.length === 0) return 'unknown';
  if (changes.includes('raise')) return 'under';
  if (changes.includes('lower')) return 'over';
  return 'ok';
}
