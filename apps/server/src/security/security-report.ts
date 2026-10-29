export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type ScanState =
  | 'clean'
  | 'vulnerable'
  | 'scanning'
  | 'not_scanned'
  | 'failed'
  | 'unsupported'
  | 'off'
  | 'error';

export type ScanReason =
  | 'external_image'
  | 'no_image'
  | 'not_scannable'
  | 'not_configured'
  | 'not_found'
  | 'unauthorized'
  | 'unreachable';

export type SeverityCounts = Record<Severity, number> & { total: number; fixable: number };

export interface ScanSummary {
  state: ScanState;
  reason: ScanReason | null;
  severity: Severity | 'none' | null;
  counts: SeverityCounts;
  progress: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  scanner: { name: string; version: string | null } | null;
}

export interface Vulnerability {
  id: string;
  package: string;
  version: string;
  fixVersion: string | null;
  severity: Severity;
  description: string | null;
  url: string | null;
  cvss: number | null;
}

export interface HarborReportSummary {
  scan_status?: string | null;
  severity?: string | null;
  summary?: {
    total?: number | null;
    fixable?: number | null;
    summary?: Record<string, number> | null;
  } | null;
  start_time?: string | null;
  end_time?: string | null;
  complete_percent?: number | null;
  scanner?: { name?: string | null; vendor?: string | null; version?: string | null } | null;
}

export interface HarborArtifact {
  digest?: string | null;
  push_time?: string | null;
  tags?: { name?: string | null }[] | null;
  scan_overview?: Record<string, HarborReportSummary> | null;
}

export interface HarborVulnerabilityItem {
  id?: string | null;
  package?: string | null;
  version?: string | null;
  fix_version?: string | null;
  severity?: string | null;
  description?: string | null;
  links?: string[] | null;
  preferred_cvss?: { score_v3?: number | null; score_v2?: number | null } | null;
}

export const REPORT_MIME_TYPES = [
  'application/vnd.security.vulnerability.report; version=1.1',
  'application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.0'
];

export const MAX_VULNERABILITIES = 500;
const MAX_DESCRIPTION = 600;

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4
};

export function normalizeSeverity(raw: unknown): Severity {
  switch (String(raw ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'negligible':
      return 'low';
    default:
      return 'unknown';
  }
}

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0, fixable: 0 };
}

export function worstSeverity(counts: SeverityCounts): Severity | 'none' {
  for (const s of SEVERITIES) if (counts[s] > 0) return s;
  return 'none';
}

export function blankSummary(state: ScanState, reason: ScanReason | null = null): ScanSummary {
  return {
    state,
    reason,
    severity: null,
    counts: emptyCounts(),
    progress: null,
    startedAt: null,
    finishedAt: null,
    scanner: null
  };
}

function pickByMime<T>(map: Record<string, T> | null | undefined): T | null {
  if (!map || typeof map !== 'object') return null;
  for (const mime of REPORT_MIME_TYPES) {
    if (map[mime]) return map[mime];
  }
  const first = Object.values(map)[0];
  return first ?? null;
}

export function pickOverview(
  artifact: HarborArtifact | null | undefined
): HarborReportSummary | null {
  return pickByMime(artifact?.scan_overview ?? null);
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t <= 0) return null;
  return new Date(t).toISOString();
}

function countOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function summarizeScan(overview: HarborReportSummary | null): ScanSummary {
  if (!overview) return blankSummary('not_scanned');
  const status = String(overview.scan_status ?? '').toLowerCase();
  const scanner = overview.scanner?.name
    ? { name: overview.scanner.name, version: overview.scanner.version ?? null }
    : null;
  const base: ScanSummary = {
    ...blankSummary('not_scanned'),
    startedAt: isoOrNull(overview.start_time),
    finishedAt: isoOrNull(overview.end_time),
    scanner
  };

  if (status === 'pending' || status === 'running' || status === 'scheduled') {
    const pct = Number(overview.complete_percent);
    return {
      ...base,
      state: 'scanning',
      finishedAt: null,
      progress: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null
    };
  }
  if (status === 'error') return { ...base, state: 'failed' };
  if (status !== 'success') return base;

  const counts = emptyCounts();
  for (const [name, n] of Object.entries(overview.summary?.summary ?? {})) {
    counts[normalizeSeverity(name)] += countOf(n);
  }
  const bySeverity = SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  counts.total = Math.max(countOf(overview.summary?.total), bySeverity);
  counts.fixable = Math.min(countOf(overview.summary?.fixable), counts.total);
  return {
    ...base,
    state: counts.total > 0 ? 'vulnerable' : 'clean',
    severity: worstSeverity(counts),
    counts
  };
}

function primaryLink(id: string, links: string[]): string | null {
  const safe = links.filter((l) => /^https:\/\//i.test(l));
  return safe.find((l) => l.includes(id)) ?? safe[0] ?? null;
}

function trimDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= MAX_DESCRIPTION) return text;
  return `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

function cvssOf(item: HarborVulnerabilityItem): number | null {
  const v = item.preferred_cvss?.score_v3 ?? item.preferred_cvss?.score_v2;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function compareVulnerabilities(a: Vulnerability, b: Vulnerability): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(!a.fixVersion) - Number(!b.fixVersion) ||
    (b.cvss ?? -1) - (a.cvss ?? -1) ||
    a.id.localeCompare(b.id) ||
    a.package.localeCompare(b.package)
  );
}

export function mapVulnerabilities(addition: unknown): Vulnerability[] {
  const report = pickByMime(addition as Record<string, { vulnerabilities?: unknown }> | null);
  const items = Array.isArray(report?.vulnerabilities)
    ? (report.vulnerabilities as HarborVulnerabilityItem[])
    : [];
  const seen = new Set<string>();
  const out: Vulnerability[] = [];
  for (const item of items) {
    const id = String(item?.id ?? '').trim();
    const pkg = String(item?.package ?? '').trim();
    if (!id || !pkg) continue;
    const version = String(item.version ?? '').trim();
    const key = `${id}\u0000${pkg}\u0000${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const links = Array.isArray(item.links) ? item.links.filter((l) => typeof l === 'string') : [];
    out.push({
      id,
      package: pkg,
      version,
      fixVersion: String(item.fix_version ?? '').trim() || null,
      severity: normalizeSeverity(item.severity),
      description: trimDescription(item.description),
      url: primaryLink(id, links),
      cvss: cvssOf(item)
    });
  }
  return out.sort(compareVulnerabilities);
}

export function countVulnerabilities(list: Vulnerability[]): SeverityCounts {
  const counts = emptyCounts();
  for (const v of list) {
    counts[v.severity] += 1;
    counts.total += 1;
    if (v.fixVersion) counts.fixable += 1;
  }
  return counts;
}

export interface ImageRegistryConfig {
  registries: string[];
  project: string;
}

export interface HarborImageRef {
  repository: string;
  reference: string;
  tag: string | null;
  digest: string | null;
}

function bareHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .replace(/:(80|443)$/, '')
    .toLowerCase();
}

export function harborImageRef(
  image: string | null | undefined,
  config: ImageRegistryConfig
): HarborImageRef | null {
  const raw = String(image ?? '').trim();
  if (!raw || !config.project) return null;
  const slash = raw.indexOf('/');
  if (slash <= 0) return null;
  const host = bareHost(raw.slice(0, slash));
  const hosts = new Set(config.registries.filter(Boolean).map(bareHost));
  if (!hosts.has(host)) return null;
  const rest = raw.slice(slash + 1);
  const prefix = `${config.project}/`;
  if (!rest.startsWith(prefix)) return null;
  const path = rest.slice(prefix.length);
  const [named, digestPart] = path.split('@');
  const digest = digestPart && /^sha256:[a-f0-9]{64}$/i.test(digestPart) ? digestPart : null;
  const colon = named.lastIndexOf(':');
  const repository = colon === -1 ? named : named.slice(0, colon);
  const tag = colon === -1 ? null : named.slice(colon + 1) || null;
  if (!repository) return null;
  return { repository, tag, digest, reference: digest ?? tag ?? 'latest' };
}

export function encodeRepository(repository: string): string {
  return encodeURIComponent(encodeURIComponent(repository));
}

export type PostureKind = 'plain-secret' | 'mutable-tag' | 'no-tls';
export type PostureSeverity = 'high' | 'medium' | 'low';

export interface PostureFinding {
  kind: PostureKind;
  severity: PostureSeverity;
  subjects: string[];
}

const SECRET_WORDS = new Set([
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'PWD',
  'KEY',
  'APIKEY',
  'SECRETKEY',
  'ACCESSKEY',
  'PRIVATEKEY',
  'AUTHTOKEN',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS'
]);

const PUBLIC_WORDS = new Set(['PUBLIC', 'PUBLISHABLE', 'PUB', 'VITE']);

const DESCRIPTOR_SUFFIXES = new Set([
  'URL',
  'URI',
  'HOST',
  'PORT',
  'PATH',
  'FILE',
  'DIR',
  'ENDPOINT',
  'ID',
  'NAME',
  'USER',
  'USERNAME',
  'TTL',
  'EXPIRY',
  'EXPIRES',
  'LENGTH',
  'LEN',
  'HEADER',
  'ISSUER',
  'ALGORITHM',
  'ALG',
  'TYPE',
  'ENABLED',
  'REGION',
  'PREFIX',
  'COUNT',
  'AGE',
  'TIMEOUT'
]);

export function looksLikeSecretName(key: string): boolean {
  const tokens = String(key ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => PUBLIC_WORDS.has(t))) return false;
  if (DESCRIPTOR_SUFFIXES.has(tokens[tokens.length - 1])) return false;
  return tokens.some((t) => SECRET_WORDS.has(t));
}

function isInertValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.includes('${{')) return true;
  return /^(true|false|yes|no|on|off|none|null|\d+)$/i.test(v);
}

export interface PostureInput {
  envVars: { key: string; value: string | null; secret: boolean }[];
  image: string | null;
  mutableTag: boolean;
  ingresses: { host: string; tlsEnabled: boolean; redirectTarget?: string | null }[];
}

export function postureFindings(input: PostureInput): PostureFinding[] {
  const out: PostureFinding[] = [];
  const plain = input.envVars
    .filter((e) => !e.secret && looksLikeSecretName(e.key) && !isInertValue(e.value ?? ''))
    .map((e) => e.key)
    .sort();
  if (plain.length > 0) out.push({ kind: 'plain-secret', severity: 'high', subjects: plain });

  const insecure = [
    ...new Set(
      input.ingresses.filter((i) => i.host && !i.tlsEnabled && !i.redirectTarget).map((i) => i.host)
    )
  ].sort();
  if (insecure.length > 0) out.push({ kind: 'no-tls', severity: 'medium', subjects: insecure });

  if (input.image && input.mutableTag) {
    out.push({ kind: 'mutable-tag', severity: 'low', subjects: [input.image] });
  }
  return out;
}
