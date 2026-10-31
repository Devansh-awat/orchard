export const POSTGRES_SECURITY_URL = 'https://www.postgresql.org/support/security/';

export const POSTGRES_VERSIONS_URL = 'https://www.postgresql.org/versions.json';

export interface PostgresAdvisory {
  cve: string;
  affectedMajors: number[];
  fixedIn: Record<number, number>;
  component: string;
  score: number | null;
  vector: string | null;
  description: string;
  url: string;
}

export interface PostgresRelease {
  major: number;
  latestMinor: number;
  supported: boolean;
  current: boolean;
  eolDate: string | null;
}

export interface PostgresVersion {
  major: number;
  minor: number | null;
}

function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\_/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAdvisories(html: string): PostgresAdvisory[] {
  const out: PostgresAdvisory[] = [];
  const seen = new Set<string>();
  for (const row of html.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi);
    if (!cells || cells.length < 5) continue;
    const cve = /CVE-\d{4}-\d{3,7}/.exec(cells[0])?.[0];
    if (!cve || seen.has(cve)) continue;
    const affectedMajors = text(cells[1])
      .split(/[,\s]+/)
      .map((v) => Number.parseInt(v, 10))
      .filter((n) => Number.isInteger(n));
    const fixedIn: Record<number, number> = {};
    for (const v of text(cells[2]).split(/[,\s]+/)) {
      const m = /^(\d+)\.(\d+)$/.exec(v);
      if (m) fixedIn[Number(m[1])] = Number(m[2]);
    }
    const vector = /class="cvssvector">([^<]+)</.exec(cells[3])?.[1]?.trim() ?? null;
    const scoreRaw = /calculator\?vector=[^"]*">([\d.]+)</.exec(cells[3])?.[1];
    const component = text(cells[3].split(/<br\s*\/?>/i)[0]);
    const description = text(cells[4].replace(/<a[^>]*>more details<\/a>/i, ''));
    seen.add(cve);
    out.push({
      cve,
      affectedMajors,
      fixedIn,
      component,
      score: scoreRaw ? Number(scoreRaw) : null,
      vector,
      description,
      url: `${POSTGRES_SECURITY_URL}${cve}/`
    });
  }
  return out;
}

export function parseReleases(json: unknown): PostgresRelease[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((r: any) => ({
      major: Number.parseInt(String(r?.major ?? ''), 10),
      latestMinor: Number.parseInt(String(r?.latestMinor ?? ''), 10),
      supported: r?.supported === true,
      current: r?.current === true,
      eolDate: typeof r?.eolDate === 'string' ? r.eolDate : null
    }))
    .filter((r) => Number.isInteger(r.major) && r.major >= 10 && Number.isInteger(r.latestMinor));
}

export function versionFromImage(image: string | null | undefined): PostgresVersion | null {
  const tag = String(image ?? '')
    .split('@')[0]
    .split(':')
    .pop();
  const m = /^(\d+)(?:\.(\d+))?/.exec(tag ?? '');
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] !== undefined ? Number(m[2]) : null };
}

export function versionFromServerVersionNum(raw: string): PostgresVersion | null {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 100000) return null;
  return { major: Math.floor(n / 10000), minor: n % 10000 };
}

export interface SecurityReport {
  running: string | null;
  major: number;
  minor: number | null;
  latestMinor: number | null;
  supported: boolean | null;
  eolDate: string | null;
  endOfLifeSoon: boolean;
  vulnerabilities: (PostgresAdvisory & { fixedInVersion: string | null })[];
  highestScore: number | null;
  action: 'none' | 'minor_update' | 'major_upgrade' | 'unknown';
}

export function securityReport(
  version: PostgresVersion,
  advisories: PostgresAdvisory[],
  releases: PostgresRelease[],
  now = Date.now()
): SecurityReport {
  const release = releases.find((r) => r.major === version.major) ?? null;
  const eolTime = release?.eolDate ? Date.parse(release.eolDate) : NaN;
  const endOfLifeSoon = Number.isFinite(eolTime) && eolTime - now < 180 * 24 * 60 * 60 * 1000;
  const vulnerabilities =
    version.minor === null
      ? []
      : advisories
          .filter((a) => a.affectedMajors.includes(version.major))
          .filter((a) => {
            const fixed = a.fixedIn[version.major];
            return fixed === undefined || version.minor! < fixed;
          })
          .map((a) => ({
            ...a,
            fixedInVersion:
              a.fixedIn[version.major] !== undefined
                ? `${version.major}.${a.fixedIn[version.major]}`
                : null
          }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const unsupported = release ? !release.supported : false;
  const unfixable = vulnerabilities.some((v) => v.fixedInVersion === null);
  let action: SecurityReport['action'] = 'none';
  if (version.minor === null) action = 'unknown';
  else if (unsupported || unfixable) action = 'major_upgrade';
  else if (vulnerabilities.length > 0 || (release && version.minor < release.latestMinor))
    action = 'minor_update';
  return {
    running: version.minor === null ? `${version.major}` : `${version.major}.${version.minor}`,
    major: version.major,
    minor: version.minor,
    latestMinor: release?.latestMinor ?? null,
    supported: release ? release.supported : null,
    eolDate: release?.eolDate ?? null,
    endOfLifeSoon,
    vulnerabilities,
    highestScore: vulnerabilities[0]?.score ?? null,
    action
  };
}
