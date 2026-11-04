/**
 * Tool results are billed to the caller's context window, so they are
 * serialised compactly. Indenting a response costs 23% more tokens on a single
 * deployment and 34% on a listing, buying nothing: the model parses either form
 * the same, and nobody reads raw tool output.
 *
 * Every tool returns through here so that stays true as tools are added.
 */
const BUILD_LOGS_OMITTED = '<omitted, call get_build_logs>';

function omitBuildLogs(key: string, value: unknown) {
  return key === 'buildLogs' && value ? BUILD_LOGS_OMITTED : value;
}

export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, omitBuildLogs) }] };
}

/** For results that are already prose or a raw log, not a structure. */
export function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function structured<T extends Record<string, unknown>>(value: T) {
  const text = JSON.stringify(value, omitBuildLogs);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: JSON.parse(text) as T
  };
}

export function failure(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export const TEXT_CAP = 20_000;

export function capText(value: string, max = TEXT_CAP): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const omitted = value.length - max;
  return {
    text: `[truncated: ${omitted} earlier characters omitted, showing the last ${max}]\n${value.slice(-max)}`,
    truncated: true
  };
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;

export function paginate<T>(
  items: T[] | null | undefined,
  options: { limit?: number; cursor?: string },
  defaultLimit = DEFAULT_PAGE_SIZE
): Page<T> {
  const all = Array.isArray(items) ? items : [];
  const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
  const limit = Math.max(1, options.limit ?? defaultLimit);
  const slice = all.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    total: all.length,
    ...(next < all.length ? { nextCursor: String(next) } : {})
  };
}

export const OUTPUT_CAP = 40_000;

type LogEntry = {
  timestamp?: string;
  level?: string;
  raw?: string;
  message?: string;
  metadata?: { pod?: string };
};

const LEADING_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/;

export function logLine(e: LogEntry): string {
  const body = (e.raw ?? e.message ?? '').replace(LEADING_TIME, '');
  return [e.timestamp ?? '', e.metadata?.pod ?? '', e.level ?? '', body].filter(Boolean).join(' ');
}

export function cursorBefore(timestamp: string | undefined): string | null {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(t)) return null;
  return Buffer.from(JSON.stringify({ end: t - 1 }), 'utf8').toString('base64url');
}

export function capLines(
  entries: LogEntry[],
  serverCursor: string | null,
  cap = OUTPUT_CAP
): { lines: string[]; truncated: boolean; cursor: string | null } {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; i < entries.length; i++) {
    const line = logLine(entries[i]);
    if (size + line.length + 1 > cap) {
      return { lines, truncated: true, cursor: cursorBefore(entries[i - 1]?.timestamp) };
    }
    lines.push(line);
    size += line.length + 1;
  }
  return { lines, truncated: !!serverCursor, cursor: serverCursor };
}

export function capJson<T>(value: T, cap = OUTPUT_CAP): T | { truncated: true; preview: string } {
  const text = JSON.stringify(value);
  if (text.length <= cap) return value;
  return { truncated: true, preview: text.slice(0, cap) };
}

export function capList<T>(
  items: T[],
  cap = OUTPUT_CAP
): { items: T[]; truncated: boolean; nextCursor?: string } {
  let size = 2;
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const len = JSON.stringify(items[i]).length + 1;
    if (size + len > cap) return { items: out, truncated: true, nextCursor: String(i) };
    out.push(items[i]);
    size += len;
  }
  return { items: out, truncated: false };
}
