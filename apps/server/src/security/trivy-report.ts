import {
  MAX_VULNERABILITIES,
  blankSummary,
  compareVulnerabilities,
  countVulnerabilities,
  normalizeSeverity,
  worstSeverity,
  type ScanSummary,
  type Vulnerability
} from './security-report';

const MAX_DESCRIPTION = 600;

type TrivyVulnerability = {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  References?: string[];
  CVSS?: Record<string, { V3Score?: number; V2Score?: number }>;
};

export interface TrivyReport {
  Trivy?: { Version?: string };
  Metadata?: { RepoDigests?: string[] };
  Results?: { Vulnerabilities?: TrivyVulnerability[] | null }[] | null;
}

export interface StoredReport {
  vulnerabilities: Vulnerability[];
  truncated: number;
  digest: string | null;
  scannerVersion: string | null;
  counts: ReturnType<typeof countVulnerabilities>;
  covered?: boolean;
}

function describe(v: TrivyVulnerability): string | null {
  const raw = [v.Title, v.Description].filter((t) => typeof t === 'string' && t.trim())[0];
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

function cvss(v: TrivyVulnerability): number | null {
  const sources = Object.values(v.CVSS ?? {});
  const scores = sources
    .map((s) => s?.V3Score ?? s?.V2Score)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return scores.length ? Math.max(...scores) : null;
}

function link(v: TrivyVulnerability): string | null {
  const all = [v.PrimaryURL, ...(v.References ?? [])].filter(
    (l): l is string => typeof l === 'string' && /^https:\/\//i.test(l)
  );
  return all[0] ?? null;
}

export function mapTrivyReport(raw: unknown): StoredReport {
  const report = (raw && typeof raw === 'object' ? raw : {}) as TrivyReport;
  const seen = new Set<string>();
  const all: Vulnerability[] = [];
  for (const result of report.Results ?? []) {
    for (const v of result?.Vulnerabilities ?? []) {
      const id = String(v?.VulnerabilityID ?? '').trim();
      const pkg = String(v?.PkgName ?? '').trim();
      if (!id || !pkg) continue;
      const version = String(v.InstalledVersion ?? '').trim();
      const key = `${id}\u0000${pkg}\u0000${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        id,
        package: pkg,
        version,
        fixVersion: String(v.FixedVersion ?? '').trim() || null,
        severity: normalizeSeverity(v.Severity),
        description: describe(v),
        url: link(v),
        cvss: cvss(v)
      });
    }
  }
  all.sort(compareVulnerabilities);
  const digest =
    (report.Metadata?.RepoDigests ?? [])
      .map((d) => /@(sha256:[a-f0-9]{64})$/i.exec(d)?.[1] ?? null)
      .find(Boolean) ?? null;
  return {
    vulnerabilities: all.slice(0, MAX_VULNERABILITIES),
    truncated: Math.max(0, all.length - MAX_VULNERABILITIES),
    digest,
    scannerVersion: report.Trivy?.Version ?? null,
    counts: countVulnerabilities(all),
    covered: (report.Results ?? []).length > 0
  };
}

export function summaryFromStored(
  stored: StoredReport,
  times: { startedAt: Date | null; finishedAt: Date | null }
): ScanSummary {
  const uncovered = stored.counts.total === 0 && stored.covered === false;
  return {
    state: stored.counts.total > 0 ? 'vulnerable' : uncovered ? 'unsupported' : 'clean',
    reason: uncovered ? 'not_scannable' : null,
    severity: worstSeverity(stored.counts),
    counts: stored.counts,
    progress: null,
    startedAt: times.startedAt?.toISOString() ?? null,
    finishedAt: times.finishedAt?.toISOString() ?? null,
    scanner: { name: 'Trivy', version: stored.scannerVersion }
  };
}

export interface ImageScanRow {
  status: string;
  digest: string | null;
  report: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface StoredScan {
  summary: ScanSummary;
  vulnerabilities: Vulnerability[] | null;
  truncated: number;
  digest: string | null;
  pushedAt: string | null;
  error: string | null;
}

export function isStale(
  row: Pick<ImageScanRow, 'status' | 'createdAt'>,
  staleMs: number,
  now: number
) {
  return row.status === 'running' && now - row.createdAt.getTime() > staleMs;
}

function asStored(report: unknown): StoredReport | null {
  if (!report || typeof report !== 'object') return null;
  const r = report as Partial<StoredReport>;
  if (!Array.isArray(r.vulnerabilities) || !r.counts) return null;
  return {
    vulnerabilities: r.vulnerabilities,
    truncated: typeof r.truncated === 'number' ? r.truncated : 0,
    digest: r.digest ?? null,
    scannerVersion: r.scannerVersion ?? null,
    counts: r.counts
  };
}

export function scanFromRow(row: ImageScanRow | null, staleMs: number, now: number): StoredScan {
  const empty = { vulnerabilities: null, truncated: 0, digest: null, pushedAt: null, error: null };
  const trivy = { name: 'Trivy', version: null };
  if (!row) return { ...empty, summary: { ...blankSummary('not_scanned'), scanner: trivy } };
  const times = {
    startedAt: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null
  };
  if (row.status === 'running' && !isStale(row, staleMs, now)) {
    return {
      ...empty,
      summary: { ...blankSummary('scanning'), progress: null, scanner: trivy, ...times }
    };
  }
  const stored = row.status === 'done' ? asStored(row.report) : null;
  if (!stored) {
    const error =
      row.status === 'running' ? 'The scan stopped responding' : row.error || 'The scan failed';
    return {
      ...empty,
      digest: row.digest,
      error,
      summary: { ...blankSummary('failed'), scanner: trivy, ...times }
    };
  }
  return {
    vulnerabilities: stored.vulnerabilities,
    truncated: stored.truncated,
    digest: row.digest ?? stored.digest,
    pushedAt: null,
    error: null,
    summary: summaryFromStored(stored, {
      startedAt: row.startedAt ?? row.createdAt,
      finishedAt: row.finishedAt
    })
  };
}

export function trivyErrorMessage(raw: string): string {
  const at = raw.lastIndexOf('FATAL');
  const tail = at >= 0 ? raw.slice(at + 'FATAL'.length) : raw;
  const text = tail
    .replace(/^\s*Fatal error\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/twirp\/.*(connection refused|i\/o timeout|no such host)/i.test(text)) {
    return "Couldn't reach the Trivy server";
  }
  return text || 'The scanner exited with an error';
}
