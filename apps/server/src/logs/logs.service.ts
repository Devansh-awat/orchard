import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ObservabilityService, type LogEntry } from '../observability/observability.service';
import { LogsStoreError, VictoriaLogsService } from './victoria-logs.service';
import { rowsToEntries } from './entries';
import {
  LOG_LEVELS,
  LogQueryError,
  buildContext,
  buildFilter,
  buildSearch,
  type LogLevel
} from './logsql';

export type LogSource = 'store' | 'live';

export interface SearchParams {
  start: number;
  end: number;
  q?: string;
  levels?: string[];
  pods?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface SearchResult {
  source: LogSource;
  entries: LogEntry[];
  cursor: string | null;
  truncated: boolean;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const LIVE_TAIL = 2000;
const EXPORT_MAX = 50_000;

export function encodeLogCursor(end: number): string {
  return Buffer.from(JSON.stringify({ end }), 'utf8').toString('base64url');
}

export function decodeLogCursor(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof parsed?.end === 'number' && Number.isFinite(parsed.end) ? parsed.end : null;
  } catch {
    return null;
  }
}

export function cleanLevels(levels: string[] | undefined): LogLevel[] {
  return (levels ?? [])
    .map((l) => l.trim().toLowerCase())
    .filter((l): l is LogLevel => (LOG_LEVELS as readonly string[]).includes(l));
}

function liveFilter(entries: LogEntry[], params: SearchParams): LogEntry[] {
  const levels = new Set(cleanLevels(params.levels).map((l) => l.toUpperCase()));
  const pods = new Set(params.pods ?? []);
  const terms = (params.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(t) && (t < params.start || t > params.end)) return false;
    if (levels.size && !levels.has((e.level ?? '').toUpperCase().replace('WARNING', 'WARN')))
      return false;
    if (pods.size && !pods.has(String(e.metadata?.pod ?? ''))) return false;
    const raw = e.raw.toLowerCase();
    return terms.every((term) => raw.includes(term));
  });
}

@Injectable()
export class LogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VictoriaLogsService,
    private readonly observability: ObservabilityService
  ) {}

  private async scopeOf(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });
    if (!deployment?.namespace) throw new NotFoundException('Deployment not found');
    return { namespace: deployment.namespace, app: deployment.name };
  }

  async search(deploymentId: string, params: SearchParams): Promise<SearchResult> {
    const scope = await this.scopeOf(deploymentId);
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursorEnd = decodeLogCursor(params.cursor);
    if (params.cursor && cursorEnd == null) throw new BadRequestException('Invalid cursor');
    const end = cursorEnd ?? params.end;
    try {
      const query = buildSearch({
        ...scope,
        kind: 'app',
        q: params.q,
        levels: cleanLevels(params.levels),
        pods: params.pods,
        start: params.start,
        end,
        limit: limit + 1
      });
      const rows = await this.store.query(query);
      if (rows.length > 0 || cursorEnd != null) {
        const page = rows.slice(0, limit);
        const oldest = page[page.length - 1]?._time;
        const more = rows.length > limit && !!oldest;
        return {
          source: 'store',
          entries: rowsToEntries(page),
          cursor: more ? encodeLogCursor(Date.parse(oldest) - 1) : null,
          truncated: more
        };
      }
    } catch (err) {
      if (err instanceof LogQueryError) throw new BadRequestException(err.message);
      if (!(err instanceof LogsStoreError)) throw err;
    }
    const live = await this.observability.getStructuredLogs(deploymentId, LIVE_TAIL);
    const filtered = liveFilter(live.entries, { ...params, end });
    const sorted = filtered.sort(
      (a, b) => (Date.parse(b.timestamp ?? '') || 0) - (Date.parse(a.timestamp ?? '') || 0)
    );
    return {
      source: 'live',
      entries: sorted.slice(0, limit),
      cursor: null,
      truncated: sorted.length > limit
    };
  }

  async levelCounts(
    deploymentId: string,
    params: { start: number; end: number; stepMs: number }
  ): Promise<{
    source: LogSource;
    levels: Record<string, { x: number; y: number }[]>;
  }> {
    const scope = await this.scopeOf(deploymentId);
    try {
      const filter = buildFilter({ ...scope, kind: 'app', start: params.start, end: params.end });
      const hits = await this.store.hits(filter, {
        start: new Date(params.start),
        end: new Date(params.end),
        stepMs: params.stepMs,
        field: 'level'
      });
      const levels: Record<string, { x: number; y: number }[]> = {};
      for (const h of hits) {
        const level = (h.fields.level || 'info').toLowerCase();
        const points = h.timestamps.map((t, i) => ({ x: Date.parse(t), y: h.values[i] ?? 0 }));
        levels[level] = [...(levels[level] ?? []), ...points].sort((a, b) => a.x - b.x);
      }
      return { source: 'store', levels };
    } catch (err) {
      if (!(err instanceof LogsStoreError)) throw err;
      return { source: 'live', levels: {} };
    }
  }

  async context(
    deploymentId: string,
    params: { at: number; pod: string; beforeMs: number; afterMs: number }
  ): Promise<{ source: LogSource; entries: LogEntry[] }> {
    const scope = await this.scopeOf(deploymentId);
    try {
      const rows = await this.store.query(
        buildContext({
          ...scope,
          pod: params.pod,
          at: params.at,
          beforeMs: params.beforeMs,
          afterMs: params.afterMs,
          limit: 400
        })
      );
      if (rows.length > 0) return { source: 'store', entries: rowsToEntries(rows).reverse() };
    } catch (err) {
      if (err instanceof LogQueryError) throw new BadRequestException(err.message);
      if (!(err instanceof LogsStoreError)) throw err;
    }
    const live = await this.observability.getStructuredLogs(deploymentId, LIVE_TAIL);
    const entries = liveFilter(live.entries, {
      start: params.at - params.beforeMs,
      end: params.at + params.afterMs,
      pods: [params.pod]
    }).sort((a, b) => (Date.parse(a.timestamp ?? '') || 0) - (Date.parse(b.timestamp ?? '') || 0));
    return { source: 'live', entries };
  }

  async *export(
    deploymentId: string,
    params: SearchParams,
    format: 'ndjson' | 'text'
  ): AsyncGenerator<string> {
    const collected: LogEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.search(deploymentId, { ...params, cursor, limit: MAX_LIMIT });
      collected.push(...page.entries);
      cursor = page.cursor;
    } while (cursor && collected.length < EXPORT_MAX);
    for (let i = collected.length - 1; i >= 0; i--) {
      const e = collected[i];
      yield format === 'ndjson'
        ? `${JSON.stringify({ time: e.timestamp, level: e.level, pod: e.metadata?.pod, message: e.raw })}\n`
        : `${e.timestamp ?? ''} ${e.metadata?.pod ?? ''} ${e.raw}\n`;
    }
  }
}
