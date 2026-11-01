export const REPO_SEARCH_LIMIT = 20;

const MAX_RAW_CHARS = 200;
const MAX_TERMS = 5;
const MAX_TERMS_CHARS = 100;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const OPERATORS = new Set(['AND', 'OR', 'NOT']);

export interface SearchInstallation {
  id: string;
  installationId: bigint | string | number;
  accountLogin: string;
  accountType: string;
}

export interface RepoQuery {
  terms: string[];
  exactName: string | null;
  foreignOwner: boolean;
  key: string;
}

export interface SearchedRepo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  updated_at: string | null;
}

export type GitHubFailure = 'rate_limited' | 'reauth' | 'denied' | 'invalid' | 'unavailable';

export function isGitHubLogin(login: unknown): login is string {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

export function pickSearchInstallation<T extends SearchInstallation>(
  installations: readonly T[],
  account: unknown
): T | null {
  if (!isGitHubLogin(account)) return null;
  const want = account.toLowerCase();
  return installations.find((i) => i.accountLogin.toLowerCase() === want) ?? null;
}

function splitOwner(text: string): { owner: string; name: string } | null {
  const url = text.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]*)/i);
  if (url) return { owner: url[1], name: url[2].replace(/\.git$/i, '') };
  const short = text.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]*)$/);
  if (short) return { owner: short[1], name: short[2] };
  return null;
}

export function sanitizeTerms(text: string): string[] {
  const terms: string[] = [];
  let length = 0;
  for (const word of text.split(/\s+/)) {
    if (!word || word.includes(':')) continue;
    for (const piece of word.replace(/[^A-Za-z0-9._-]+/g, ' ').split(' ')) {
      const term = piece.replace(/^-+/, '');
      if (!term || OPERATORS.has(term) || terms.includes(term)) continue;
      if (terms.length >= MAX_TERMS || length + term.length > MAX_TERMS_CHARS) return terms;
      terms.push(term);
      length += term.length + 1;
    }
  }
  return terms;
}

export function normalizeRepoQuery(account: string, raw: unknown): RepoQuery {
  let text = (typeof raw === 'string' ? raw : '').slice(0, MAX_RAW_CHARS).trim();
  let exactName: string | null = null;
  const split = splitOwner(text);
  if (split) {
    if (split.owner.toLowerCase() !== account.toLowerCase()) {
      return { terms: [], exactName: null, foreignOwner: true, key: '' };
    }
    text = split.name;
    if (NAME_RE.test(split.name) && split.name !== '.' && split.name !== '..') {
      exactName = split.name;
    }
  }
  const terms = sanitizeTerms(text);
  if (!exactName && terms.length === 1 && NAME_RE.test(terms[0]) && !/^\.+$/.test(terms[0])) {
    exactName = terms[0];
  }
  return {
    terms,
    exactName,
    foreignOwner: false,
    key: terms.join(' ').toLowerCase()
  };
}

export function buildSearchQ(
  installation: Pick<SearchInstallation, 'accountLogin' | 'accountType'>,
  terms: readonly string[]
): string {
  if (!isGitHubLogin(installation.accountLogin)) {
    throw new Error(`not a GitHub login: ${installation.accountLogin}`);
  }
  const scope = installation.accountType === 'Organization' ? 'org' : 'user';
  const parts = [
    ...(terms.length > 0 ? [...terms, 'in:name'] : []),
    `${scope}:${installation.accountLogin}`,
    'fork:true',
    'archived:false'
  ];
  return parts.join(' ');
}

export function toSearchedRepo(item: any): SearchedRepo | null {
  if (!item || typeof item.id !== 'number' || typeof item.full_name !== 'string') return null;
  const owner = item.owner?.login ?? item.full_name.split('/')[0];
  return {
    id: item.id,
    name: item.name ?? item.full_name.split('/')[1] ?? '',
    full_name: item.full_name,
    owner,
    private: item.private === true,
    default_branch: item.default_branch || 'main',
    pushed_at: item.pushed_at ?? null,
    updated_at: item.updated_at ?? null
  };
}

export function ownedBy(repo: SearchedRepo, account: string): boolean {
  return repo.owner.toLowerCase() === account.toLowerCase();
}

export function rankRepos(
  repos: readonly SearchedRepo[],
  terms: readonly string[]
): SearchedRepo[] {
  if (terms.length === 0) return [...repos];
  const joined = terms.join('-').toLowerCase();
  const first = terms[0].toLowerCase();
  const score = (r: SearchedRepo) => {
    const name = r.name.toLowerCase();
    if (name === joined || name === first) return 0;
    if (name.startsWith(first)) return 1;
    return 2;
  };
  return repos
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.r);
}

export function mergeExact(
  repos: readonly SearchedRepo[],
  exact: SearchedRepo | null
): SearchedRepo[] {
  if (!exact || repos.some((r) => r.id === exact.id)) return [...repos];
  return [exact, ...repos];
}

export function classifyGitHubFailure(
  status: number,
  headers: { get(name: string): string | null },
  message = ''
): GitHubFailure {
  if (status === 401) return 'reauth';
  if (status === 429) return 'rate_limited';
  if (status === 403) {
    if (
      headers.get('x-ratelimit-remaining') === '0' ||
      headers.get('retry-after') !== null ||
      /rate limit/i.test(message)
    ) {
      return 'rate_limited';
    }
    return 'denied';
  }
  if (status === 422) return 'invalid';
  return 'unavailable';
}

export function retryAfterSeconds(
  headers: { get(name: string): string | null },
  nowMs = Date.now()
): number {
  const clamp = (n: number) => Math.min(60, Math.max(1, Math.ceil(n)));
  const after = Number(headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return clamp(after);
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return clamp(reset - nowMs / 1000);
  return 10;
}

export class RepoSearchError extends Error {
  constructor(
    readonly kind: GitHubFailure | 'not_installed',
    readonly retryAfter: number | null = null
  ) {
    super(`github repo search failed: ${kind}`);
  }
}

export function repoSearchErrorResponse(e: RepoSearchError): {
  status: number;
  body: { statusCode: number; code: string; message: string; retryAfter?: number };
} {
  const reply = (status: number, code: string, message: string, retryAfter?: number) => ({
    status,
    body: { statusCode: status, code, message, ...(retryAfter ? { retryAfter } : {}) }
  });
  switch (e.kind) {
    case 'not_installed':
      return reply(
        404,
        'github_account_not_installed',
        'The GitHub App is not installed on that account.'
      );
    case 'reauth':
      return reply(
        400,
        'github_reconnect',
        'Your GitHub session expired. Reconnect GitHub to search your repositories.'
      );
    case 'rate_limited':
      return reply(
        429,
        'github_rate_limited',
        'GitHub is rate limiting searches, try again in a moment',
        e.retryAfter ?? 10
      );
    case 'denied':
      return reply(403, 'github_denied', 'GitHub refused this search.');
    default:
      return reply(
        502,
        'github_unavailable',
        'GitHub search is not responding, try again in a moment'
      );
  }
}
