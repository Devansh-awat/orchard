import tracer from 'dd-trace';

export interface CacheStats {
  steps: number;
  cached: number;
}

export type CacheClass = 'full' | 'partial' | 'none' | 'unknown';

export type PipelineOutcome = 'succeeded' | 'failed' | 'cancelled';

const STEP_LINE = /^#([0-9a-f]+) (.*)$/;
const DONE = /^DONE \d/;
const INTERNAL_STEP =
  /^(\[internal\]|\[auth\]|\[railpack\]|\[[^\]]*\] FROM |docker-image:\/\/|loading \.|load build definition|load \.dockerignore|load metadata for|resolve image config|exporting|writing image|naming to|unpacking|pushing|importing cache|preparing build cache)/i;

export function buildCacheStats(logs: string | null | undefined): CacheStats {
  const names = new Map<string, string>();
  const results = new Map<string, 'cached' | 'done'>();
  for (const line of (logs ?? '').split('\n')) {
    const match = STEP_LINE.exec(line);
    if (!match) continue;
    const [, id, rest] = match;
    if (!names.has(id)) {
      names.set(id, rest);
      continue;
    }
    if (rest === 'CACHED') results.set(id, 'cached');
    else if (DONE.test(rest) && results.get(id) !== 'cached') results.set(id, 'done');
  }
  let steps = 0;
  let cached = 0;
  for (const [id, result] of results) {
    if (INTERNAL_STEP.test(names.get(id) ?? '')) continue;
    steps++;
    if (result === 'cached') cached++;
  }
  return { steps, cached };
}

export function cacheClass(stats: CacheStats): CacheClass {
  if (stats.steps === 0) return 'unknown';
  if (stats.cached === stats.steps) return 'full';
  if (stats.cached === 0) return 'none';
  return 'partial';
}

const PHASES: ReadonlyArray<[phase: string, from: string, to: string]> = [
  ['queue', '__start', 'cloning'],
  ['setup', 'cloning', 'building'],
  ['build', 'building', 'pushing'],
  ['push', 'pushing', 'deploying'],
  ['rollout', 'deploying', 'complete']
];

export function phaseDurations(
  stamps: Record<string, unknown> | null | undefined,
  endedAt: number
): { phases: Record<string, number>; totalMs: number | null } {
  const at = (key: string) => {
    const value = stamps?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const phases: Record<string, number> = {};
  for (const [phase, from, to] of PHASES) {
    const start = at(from);
    const end = at(to);
    if (start !== null && end !== null && end >= start) phases[phase] = end - start;
  }
  const start = at('__start');
  const end = at('complete') ?? endedAt;
  return { phases, totalMs: start !== null && end >= start ? end - start : null };
}

export function pipelineOutcome(succeeded: boolean, error?: string | null): PipelineOutcome {
  if (succeeded) return 'succeeded';
  return /cancel/i.test(error ?? '') ? 'cancelled' : 'failed';
}

interface Statsd {
  increment(name: string, value?: number, tags?: string[]): void;
  distribution(name: string, value: number, tags?: string[]): void;
}

export function recordBuildPipeline(meta: {
  outcome: PipelineOutcome;
  builder: string;
  buildType: string;
  logs: string | null | undefined;
  stamps: Record<string, unknown> | null | undefined;
  endedAt?: number;
}): void {
  try {
    const statsd = (tracer as unknown as { dogstatsd?: Statsd }).dogstatsd;
    if (!statsd) return;
    const cache = buildCacheStats(meta.logs);
    const kind = cacheClass(cache);
    const base = [`builder:${meta.builder}`, `build_type:${meta.buildType}`];
    const tags = [...base, `outcome:${meta.outcome}`, `cache:${kind}`];
    statsd.increment('orchard.build.pipeline.count', 1, tags);
    const { phases, totalMs } = phaseDurations(meta.stamps, meta.endedAt ?? Date.now());
    if (totalMs !== null) statsd.distribution('orchard.build.pipeline.duration_ms', totalMs, tags);
    for (const [phase, ms] of Object.entries(phases)) {
      statsd.distribution('orchard.build.phase.duration_ms', ms, [...tags, `phase:${phase}`]);
    }
    if (cache.steps > 0 && meta.outcome === 'succeeded') {
      statsd.distribution('orchard.build.cache.hit_pct', (cache.cached / cache.steps) * 100, base);
      statsd.increment('orchard.build.cache.steps', cache.cached, [...base, 'result:cached']);
      statsd.increment('orchard.build.cache.steps', cache.steps - cache.cached, [
        ...base,
        'result:executed'
      ]);
    }
  } catch {
    return;
  }
}
