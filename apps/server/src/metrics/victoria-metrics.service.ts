import { Injectable, Logger } from '@nestjs/common';

export interface SeriesPoint {
  x: number;
  y: number;
}

export interface GroupedSeries {
  key: string;
  points: SeriesPoint[];
}

export type InstantResult = { ok: true; value: number | null } | { ok: false; reason: string };

interface PromVector {
  status: string;
  data?: {
    resultType: string;
    result: { metric?: Record<string, string>; value: [number, string] }[];
  };
}

interface PromMatrix {
  status: string;
  data?: {
    resultType: string;
    result: { metric: Record<string, string>; values: [number, string][] }[];
  };
}

const QUERY_TIMEOUT_MS = 30_000;

export class MetricsStoreError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MetricsStoreError';
  }
}

export function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The one client for the metrics store. Every PromQL in the server goes
 * through here so the base URL, timeout and response parsing exist once.
 *
 * Two shapes of the instant query on purpose. `queryInstant` folds every
 * failure into null, which is what a dashboard wants: an empty stat, not an
 * error page. `queryInstantStrict` keeps "the store did not answer" apart
 * from "the store answered with no series", because an alert that reads an
 * outage as a zero would silently resolve itself the moment the metrics
 * store went away.
 */
@Injectable()
export class VictoriaMetricsService {
  private readonly logger = new Logger(VictoriaMetricsService.name);

  readonly base =
    process.env.VICTORIAMETRICS_URL ??
    'http://victoriametrics.orchard-metrics.svc.cluster.local:8428';

  async queryInstant(promql: string): Promise<number | null> {
    const result = await this.queryInstantStrict(promql);
    return result.ok ? result.value : null;
  }

  async queryInstantStrict(promql: string): Promise<InstantResult> {
    const params = new URLSearchParams({ query: promql });
    const url = `${this.base}/api/v1/query?${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(`VM query ${res.status}: ${text}`);
        return { ok: false, reason: `metrics store answered ${res.status}` };
      }
      const body = (await res.json()) as PromVector;
      if (body.status !== 'success') {
        return { ok: false, reason: `metrics store returned ${body.status}` };
      }
      if (!body.data?.result?.length) return { ok: true, value: null };
      const v = Number(body.data.result[0].value[1]);
      return { ok: true, value: Number.isFinite(v) ? v : null };
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`VM query failed: ${reason}`);
      return { ok: false, reason: `metrics store unreachable: ${reason}` };
    }
  }

  async queryInstantGrouped(promql: string, label: string): Promise<Map<string, number>> {
    const params = new URLSearchParams({ query: promql });
    const url = `${this.base}/api/v1/query?${params}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`VM query failed: ${reason}`);
      throw new MetricsStoreError(`metrics store unreachable: ${reason}`);
    }
    if (!res.ok) {
      this.logger.warn(`VM query ${res.status}: ${await res.text()}`);
      throw new MetricsStoreError(`metrics store answered ${res.status}`);
    }
    const body = (await res.json()) as PromVector;
    if (body.status !== 'success') {
      throw new MetricsStoreError(`metrics store returned ${body.status}`);
    }
    const out = new Map<string, number>();
    for (const r of body.data?.result ?? []) {
      const key = r.metric?.[label];
      const v = Number(r.value[1]);
      if (key && Number.isFinite(v)) out.set(key, v);
    }
    return out;
  }

  async queryRange(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number
  ): Promise<SeriesPoint[]> {
    const grouped = await this.queryRangeGrouped(promql, startSec, endSec, stepSec, null);
    return grouped[0]?.points ?? [];
  }

  async queryRangeGrouped(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number,
    label: string | null
  ): Promise<GroupedSeries[]> {
    const params = new URLSearchParams({
      query: promql,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec)
    });
    const url = `${this.base}/api/v1/query_range?${params}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`VM query_range failed: ${reason}`);
      throw new MetricsStoreError(`metrics store unreachable: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`VM query_range ${res.status}: ${text}`);
      throw new MetricsStoreError(`metrics store answered ${res.status}`);
    }
    const body = (await res.json()) as PromMatrix;
    if (body.status !== 'success') {
      throw new MetricsStoreError(`metrics store returned ${body.status}`);
    }
    if (!body.data?.result?.length) return [];
    const series = body.data.result.map((r) => ({
      key: label ? (r.metric?.[label] ?? 'unknown') : '',
      points: r.values.map(([t, v]) => ({ x: t * 1000, y: Number(v) }))
    }));
    return label ? series.sort((a, b) => a.key.localeCompare(b.key)) : series;
  }
}
