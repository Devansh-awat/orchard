export type RequestKind = 'scanner' | 'injection';

export type AttackKind = RequestKind | 'auth-bruteforce' | 'flood';

export const ATTACK_KINDS: readonly AttackKind[] = [
  'scanner',
  'injection',
  'auth-bruteforce',
  'flood'
];

export interface AccessRecord {
  t: number;
  clientIp: string;
  method: string;
  path: string;
  status: number;
  userAgent: string;
  host: string;
}

export interface DetectOptions {
  start: number;
  end: number;
  bucketMs: number;
}

export type AttackBucket = { t: number } & Record<AttackKind, number>;

export interface AttackSource {
  ip: string;
  count: number;
  kinds: AttackKind[];
  hidden?: boolean;
}

export function foldInternalSources(sources: AttackSource[]): AttackSource[] {
  const out: AttackSource[] = [];
  let hidden: AttackSource | null = null;
  for (const s of sources) {
    if (!internalIp(s.ip)) {
      out.push(s);
      continue;
    }
    hidden ??= { ip: '', count: 0, kinds: [], hidden: true };
    hidden.count += s.count;
    hidden.kinds = [...new Set<AttackKind>([...hidden.kinds, ...s.kinds])];
  }
  if (hidden) out.push(hidden);
  return out.sort((a, b) => b.count - a.count);
}

export interface AttackSample {
  t: number;
  ip: string;
  method: string;
  path: string;
  status: number;
  kind: AttackKind;
}

export interface AttackReport {
  byKind: Record<AttackKind, number>;
  series: AttackBucket[];
  topSources: AttackSource[];
  samples: AttackSample[];
}

export const BRUTEFORCE_WINDOW_MS = 5 * 60_000;
export const BRUTEFORCE_MIN_FAILURES = 21;
export const FLOOD_MIN_REQUESTS = 300;
export const FLOOD_MEDIAN_RATIO = 10;
export const FLOOD_MIN_IPS = 5;
export const SAMPLE_CAP = 50;
export const TOP_SOURCES_CAP = 20;
const MAX_BUCKETS = 10_000;
const SAMPLE_PATH_MAX = 300;

const SCANNER_PATHS = [
  /\/\.env(?![a-z0-9_-])/,
  /\/wp-admin(?![a-z0-9_-])/,
  /\/wp-login\.php/,
  /\/\.git(\/|$|\?)/,
  /\/phpmyadmin/,
  /\/vendor\/phpunit/,
  /\/cgi-bin(\/|$|\?)/,
  /\/\.aws(\/|$|\?)/,
  /\/server-status(?![a-z0-9_-])/
];

const SCANNER_AGENTS = /sqlmap|nikto|nuclei|masscan|zgrab/i;

const INJECTION = [
  /['"`]\s*\)*\s*(or|and)\b\s*['"`]?\w*['"`]?\s*(=|like\b|<|>)/,
  /['"`]\s*\)*\s*(;|--|#|\/\*)/,
  /['"`]\s*\)*\s*(union|select|order\s+by|group\s+by|having)\b/,
  /\bunion(\s+|\/\*.*?\*\/)+(all\s+|distinct\s+)?select\b/,
  /\b(or|and)\s+(\d+)\s*=\s*\2\b/,
  /\b(sleep|benchmark|pg_sleep|waitfor\s+delay)\s*\(/,
  /\.\.[\\/]/,
  /<\s*script/,
  /\bonerror\s*=/,
  /\$\{\s*(jndi|\$\{|lower:|upper:|env:)/
];

const HEX_PAIR = /%([0-9a-f]{2})/gi;

export function safeDecode(raw: string): string {
  let out = typeof raw === 'string' ? raw : '';
  for (let i = 0; i < 3; i++) {
    const next = out.replace(HEX_PAIR, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === out) break;
    out = next;
  }
  return out;
}

function normalized(path: string): string {
  return safeDecode(path.replace(/\+/g, ' ')).toLowerCase();
}

export function classifyRequest(r: Pick<AccessRecord, 'path' | 'userAgent'>): RequestKind | null {
  const path = normalized(r.path ?? '');
  if (INJECTION.some((re) => re.test(path))) return 'injection';
  if (SCANNER_PATHS.some((re) => re.test(path))) return 'scanner';
  if (r.userAgent && SCANNER_AGENTS.test(r.userAgent)) return 'scanner';
  return null;
}

function bare(path: string): string {
  const i = path.indexOf('?');
  return i < 0 ? path : path.slice(0, i);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bruteforce(records: AccessRecord[]): Set<number> {
  const groups = new Map<string, number[]>();
  records.forEach((r, i) => {
    if (r.status !== 401 && r.status !== 403) return;
    const key = `${r.clientIp}\u0000${bare(r.path)}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  const hit = new Set<number>();
  for (const list of groups.values()) {
    if (list.length < BRUTEFORCE_MIN_FAILURES) continue;
    list.sort((a, b) => records[a].t - records[b].t);
    let lo = 0;
    let marked = -1;
    for (let hi = 0; hi < list.length; hi++) {
      while (records[list[hi]].t - records[list[lo]].t >= BRUTEFORCE_WINDOW_MS) lo++;
      if (hi - lo + 1 < BRUTEFORCE_MIN_FAILURES) continue;
      for (let k = Math.max(lo, marked + 1); k <= hi; k++) hit.add(list[k]);
      marked = hi;
    }
  }
  return hit;
}

function floods(records: AccessRecord[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.clientIp, (counts.get(r.clientIp) ?? 0) + 1);
  const out = new Set<string>();
  if (counts.size < FLOOD_MIN_IPS) return out;
  const usual = median([...counts.values()]);
  for (const [ip, n] of counts) {
    if (n >= FLOOD_MIN_REQUESTS && n > usual * FLOOD_MEDIAN_RATIO) out.add(ip);
  }
  return out;
}

function emptyCounts(): Record<AttackKind, number> {
  return { scanner: 0, injection: 0, 'auth-bruteforce': 0, flood: 0 };
}

function pickSamples(flagged: { r: AccessRecord; kind: AttackKind }[]): AttackSample[] {
  const lanes = new Map<AttackKind, { r: AccessRecord; kind: AttackKind }[]>();
  for (const f of flagged) {
    const lane = lanes.get(f.kind);
    if (lane) lane.push(f);
    else lanes.set(f.kind, [f]);
  }
  for (const lane of lanes.values()) lane.sort((a, b) => b.r.t - a.r.t);
  const picked: AttackSample[] = [];
  const order = ATTACK_KINDS.filter((k) => lanes.has(k));
  for (let i = 0; picked.length < SAMPLE_CAP; i++) {
    let any = false;
    for (const k of order) {
      const f = lanes.get(k)![i];
      if (!f || picked.length >= SAMPLE_CAP) continue;
      any = true;
      picked.push({
        t: f.r.t,
        ip: f.r.clientIp,
        method: f.r.method,
        path: f.r.path.length > SAMPLE_PATH_MAX ? f.r.path.slice(0, SAMPLE_PATH_MAX) : f.r.path,
        status: f.r.status,
        kind: f.kind
      });
    }
    if (!any) break;
  }
  return picked.sort((a, b) => b.t - a.t);
}

export function detectAttacks(records: AccessRecord[], opts: DetectOptions): AttackReport {
  const { start, end } = opts;
  const span = Math.max(0, end - start);
  const bucketMs = Math.max(1, opts.bucketMs, Math.ceil(span / MAX_BUCKETS));
  const inRange = records.filter(
    (r) => r && Number.isFinite(r.t) && r.t >= start && r.t < end && typeof r.clientIp === 'string'
  );
  const brute = bruteforce(inRange);
  const flooding = floods(inRange);

  const byKind = emptyCounts();
  const buckets = Math.ceil(span / bucketMs);
  const series: AttackBucket[] = Array.from({ length: buckets }, (_, i) => ({
    t: start + i * bucketMs,
    ...emptyCounts()
  }));
  const sources = new Map<string, { count: number; kinds: Set<AttackKind> }>();
  const flagged: { r: AccessRecord; kind: AttackKind }[] = [];

  inRange.forEach((r, i) => {
    const kinds: AttackKind[] = [];
    const single = classifyRequest(r);
    if (single) kinds.push(single);
    if (brute.has(i)) kinds.push('auth-bruteforce');
    if (flooding.has(r.clientIp)) kinds.push('flood');
    if (!kinds.length) return;
    const bucket = series[Math.floor((r.t - start) / bucketMs)];
    for (const k of kinds) {
      byKind[k]++;
      if (bucket) bucket[k]++;
    }
    const src = sources.get(r.clientIp) ?? { count: 0, kinds: new Set<AttackKind>() };
    src.count++;
    for (const k of kinds) src.kinds.add(k);
    sources.set(r.clientIp, src);
    flagged.push({ r, kind: kinds[0] });
  });

  const topSources = [...sources.entries()]
    .map(([ip, s]) => ({ ip, count: s.count, kinds: ATTACK_KINDS.filter((k) => s.kinds.has(k)) }))
    .sort((a, b) => b.count - a.count || (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0))
    .slice(0, TOP_SOURCES_CAP);

  return { byKind, series, topSources, samples: pickSamples(flagged) };
}

function maskV4(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !(n >= 0 && n <= 255))) return null;
  return `${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
}

function expandV6(ip: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (i === groups.length - 1 && g.includes('.')) {
        const v4 = g.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

export function internalIp(ip: string): boolean {
  let raw = typeof ip === 'string' ? ip.trim() : '';
  const bracket = /^\[([^\]]+)\](:\d+)?$/.exec(raw);
  if (bracket) raw = bracket[1];
  raw = raw.replace(/%.*$/, '').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');
  if (!raw) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(raw);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const groups = expandV6(raw);
  if (!groups) return false;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return internalIp(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  return (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80;
}

export function maskIp(ip: string): string {
  let raw = typeof ip === 'string' ? ip.trim() : '';
  const bracket = /^\[([^\]]+)\](:\d+)?$/.exec(raw);
  if (bracket) raw = bracket[1];
  raw = raw.replace(/%.*$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(raw))
    return maskV4(raw.replace(/:\d+$/, '')) ?? 'unknown';
  const groups = expandV6(raw);
  if (!groups) return 'unknown';
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.0/24`;
  }
  const prefix = groups.slice(0, 3);
  while (prefix.length && prefix[prefix.length - 1] === 0) prefix.pop();
  return `${prefix.map((g) => g.toString(16)).join(':')}::/48`;
}
