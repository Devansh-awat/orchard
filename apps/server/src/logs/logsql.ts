export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_KINDS = ['app', 'access'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export type TimeInput = Date | string | number;

export interface LogScope {
  namespace: string;
  app: string;
  kind?: LogKind;
}

export interface TimeWindow {
  start: TimeInput;
  end: TimeInput;
}

export interface SearchOptions extends LogScope, TimeWindow {
  q?: string;
  levels?: readonly string[];
  pods?: readonly string[];
  limit?: number;
}

export type FilterOptions = Omit<SearchOptions, 'limit'>;

export interface AccessOptions extends TimeWindow {
  namespace: string;
  app: string;
}

export interface ContextOptions {
  namespace: string;
  app: string;
  pod: string;
  at: TimeInput;
  beforeMs: number;
  afterMs: number;
  limit?: number;
}

export class LogQueryError extends Error {}

export const MAX_SEARCH_TERMS = 16;
export const MAX_TERM_LENGTH = 256;
export const MAX_LIST_VALUES = 100;
export const MAX_LIMIT = 5000;
export const MAX_CONTEXT_MS = 6 * 60 * 60 * 1000;

const SHORT_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

export function quote(value: string): string {
  if (typeof value !== 'string') throw new LogQueryError('quote expects a string');
  let out = '"';
  for (const ch of value) {
    if (/^[\uD800-\uDFFF]$/.test(ch)) out += '\uFFFD';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (SHORT_ESCAPES[ch]) out += SHORT_ESCAPES[ch];
    else if (/\p{Cc}/u.test(ch)) out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function requireValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LogQueryError(`${name} is required`);
  }
  return value;
}

function requireKind(kind: unknown): LogKind {
  if (!LOG_KINDS.includes(kind as LogKind))
    throw new LogQueryError(`unknown log kind: ${String(kind)}`);
  return kind as LogKind;
}

export function scope({ namespace, app, kind }: LogScope): string {
  const parts = [
    `namespace=${quote(requireValue('namespace', namespace))}`,
    `app=${quote(requireValue('app', app))}`
  ];
  if (kind !== undefined) parts.push(`kind=${quote(requireKind(kind))}`);
  return `{${parts.join(',')}}`;
}

export function toTime(value: TimeInput, name = 'time'): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new LogQueryError(`${name} is not a valid time`);
  return date;
}

export function timeRange(start: TimeInput, end: TimeInput): string {
  const from = toTime(start, 'start');
  const to = toTime(end, 'end');
  if (from.getTime() > to.getTime()) throw new LogQueryError('start is after end');
  return `_time:[${from.toISOString()}, ${to.toISOString()}]`;
}

export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  const terms: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of q.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term) terms.push(term);
  }
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new LogQueryError(`search is limited to ${MAX_SEARCH_TERMS} terms`);
  }
  for (const term of terms) {
    if ([...term].length > MAX_TERM_LENGTH) {
      throw new LogQueryError(`search terms are limited to ${MAX_TERM_LENGTH} characters`);
    }
  }
  return terms;
}

function inList(field: string, values: readonly string[]): string {
  if (values.length > MAX_LIST_VALUES) {
    throw new LogQueryError(`${field} filter is limited to ${MAX_LIST_VALUES} values`);
  }
  for (const value of values) requireValue(field, value);
  return `${field}:in(${[...new Set(values)].map(quote).join(',')})`;
}

function levelFilter(levels: readonly string[] | undefined): string | null {
  if (!levels?.length) return null;
  for (const level of levels) {
    if (!LOG_LEVELS.includes(level as LogLevel))
      throw new LogQueryError(`unknown log level: ${level}`);
  }
  return inList('level', levels);
}

function count(name: string, value: number, max = MAX_LIMIT): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new LogQueryError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function limitPipe(limit: number | undefined): string {
  return limit === undefined ? '' : ` | limit ${count('limit', limit)}`;
}

export function buildFilter(opts: FilterOptions): string {
  const parts = [scope(opts), timeRange(opts.start, opts.end)];
  const levels = levelFilter(opts.levels);
  if (levels) parts.push(levels);
  if (opts.pods?.length) parts.push(inList('pod', opts.pods));
  for (const term of searchTerms(opts.q)) parts.push(`i(${quote(term)})`);
  return parts.join(' ');
}

export function buildSearch(opts: SearchOptions): string {
  return `${buildFilter(opts)} | sort by (_time desc)${limitPipe(opts.limit)}`;
}

export function buildLevelCounts(opts: Omit<FilterOptions, 'levels'>): string {
  return `${buildFilter({ ...opts, levels: undefined })} | stats by (level) count() hits`;
}

function accessScope(opts: AccessOptions): string {
  return `${scope({ namespace: opts.namespace, app: opts.app, kind: 'access' })} ${timeRange(opts.start, opts.end)}`;
}

export function buildRouteStats(opts: AccessOptions & { limit?: number }): string {
  return (
    `${accessScope(opts)} | stats by (host, route) count() requests, count() if (status:>=500) errors, ` +
    'quantile(0.5, duration_ms) p50, quantile(0.95, duration_ms) p95, quantile(0.99, duration_ms) p99' +
    ` | sort by (requests desc)${limitPipe(opts.limit)}`
  );
}

export function buildClients(opts: AccessOptions, n = 10): { ips: string; agents: string } {
  const top = count('n', n, 1000);
  const base = accessScope(opts);
  return {
    ips: `${base} | top ${top} by (client_ip)`,
    agents: `${base} | top ${top} by (user_agent)`
  };
}

export function buildSlowest(opts: AccessOptions, n = 20): string {
  return `${accessScope(opts)} | sort by (duration_ms desc) | limit ${count('n', n, 1000)}`;
}

function windowMs(name: string, ms: number): number {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_CONTEXT_MS) {
    throw new LogQueryError(`${name} must be between 0 and ${MAX_CONTEXT_MS}`);
  }
  return ms;
}

export function buildContext(opts: ContextOptions): string {
  const at = toTime(opts.at, 'at').getTime();
  const start = at - windowMs('beforeMs', opts.beforeMs);
  const end = at + windowMs('afterMs', opts.afterMs);
  return (
    `${scope({ namespace: opts.namespace, app: opts.app, kind: 'app' })} ${timeRange(start, end)} ` +
    `pod:=${quote(requireValue('pod', opts.pod))} | sort by (_time)${limitPipe(opts.limit)}`
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const LONG_TOKEN = /^[A-Za-z0-9_-]{20,}$/;
const SHORT_TOKEN = /^[A-Za-z0-9]{8,}$/;

function isIdSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    UUID.test(segment) ||
    HEX.test(segment) ||
    (LONG_TOKEN.test(segment) && /\d/.test(segment)) ||
    (SHORT_TOKEN.test(segment) && /\d.*\d.*\d/.test(segment))
  );
}

export function normalizeRoute(path: string): string {
  let clean = path ?? '';
  const query = clean.indexOf('?');
  if (query >= 0) clean = clean.slice(0, query);
  const fragment = clean.indexOf('#');
  if (fragment >= 0) clean = clean.slice(0, fragment);
  if (clean === '') return '/';
  return clean
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
}
