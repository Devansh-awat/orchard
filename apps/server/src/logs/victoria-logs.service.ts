import { Injectable, Logger } from '@nestjs/common';

const DEFAULT_URL = 'http://victorialogs.orchard-metrics.svc.cluster.local:9428';
const QUERY_TIMEOUT_MS = 10_000;

export class LogsStoreError extends Error {}

export type LogRow = Record<string, string>;

export function parseJsonLines(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed as LogRow);
    } catch {
      continue;
    }
  }
  return rows;
}

@Injectable()
export class VictoriaLogsService {
  private readonly logger = new Logger(VictoriaLogsService.name);

  private readonly base = (process.env.VICTORIALOGS_URL || DEFAULT_URL).replace(/\/$/, '');

  get configured(): boolean {
    return !!process.env.VICTORIALOGS_URL;
  }

  async query(
    logsql: string,
    opts: { limit?: number; timeoutMs?: number } = {}
  ): Promise<LogRow[]> {
    const body = new URLSearchParams({ query: logsql });
    if (opts.limit) body.set('limit', String(opts.limit));
    const text = await this.post('/select/logsql/query', body, opts.timeoutMs);
    return parseJsonLines(text);
  }

  async stream(logsql: string, opts: { limit?: number } = {}): Promise<ReadableStream<Uint8Array>> {
    const body = new URLSearchParams({ query: logsql });
    if (opts.limit) body.set('limit', String(opts.limit));
    const res = await this.fetch('/select/logsql/query', body, 60_000);
    if (!res.body) throw new LogsStoreError('logs store returned no body');
    return res.body;
  }

  async hits(
    logsql: string,
    opts: { start: Date; end: Date; stepMs: number; field?: string }
  ): Promise<{ fields: Record<string, string>; timestamps: string[]; values: number[] }[]> {
    const body = new URLSearchParams({
      query: logsql,
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
      step: `${Math.max(1, Math.round(opts.stepMs / 1000))}s`
    });
    if (opts.field) body.set('field', opts.field);
    const text = await this.post('/select/logsql/hits', body);
    try {
      const parsed = JSON.parse(text) as {
        hits?: { fields?: Record<string, string>; timestamps?: string[]; values?: number[] }[];
      };
      return (parsed.hits ?? []).map((h) => ({
        fields: h.fields ?? {},
        timestamps: h.timestamps ?? [],
        values: h.values ?? []
      }));
    } catch {
      throw new LogsStoreError('logs store returned an unreadable hits response');
    }
  }

  async reachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: URLSearchParams, timeoutMs?: number): Promise<string> {
    const res = await this.fetch(path, body, timeoutMs);
    return res.text();
  }

  private async fetch(path: string, body: URLSearchParams, timeoutMs = QUERY_TIMEOUT_MS) {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`logs store unreachable: ${reason}`);
      throw new LogsStoreError(`logs store unreachable: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`logs store ${res.status}: ${text.slice(0, 300)}`);
      throw new LogsStoreError(`logs store answered ${res.status}`);
    }
    return res;
  }
}
