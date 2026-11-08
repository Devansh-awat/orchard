import { Minimatch } from 'minimatch';

export const MAX_WATCH_PATHS = 50;

export const MAX_WATCH_PATH_LENGTH = 500;

const PUSH_COMMIT_PAYLOAD_LIMIT = 2048;

// The compare endpoint reports at most 300 files, so a response sitting on the
// cap is a truncation rather than an answer.
const COMPARE_FILE_LIMIT = 300;

const GLOB_CHARS = /[*?[\]{}]/;

export function normalizeWatchPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

export function normalizeWatchPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    const negated = trimmed.startsWith('!');
    const body = normalizeWatchPath(negated ? trimmed.slice(1) : trimmed);
    if (!body || body === '/') continue;
    const pattern = negated ? `!${body}` : body;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

const MAX_WATCH_PATH_SEGMENTS = 32;

const MAX_WATCH_PATH_GLOBSTARS = 8;

const MAX_WATCH_PATH_BRACES = 4;

const MAX_MATCHED_PATH_LENGTH = 4096;

const BRACE_RANGE = /\{[^{}]*\.\.[^{}]*\}/;

type Matcher = (path: string) => boolean;

const matcherCache = new Map<string, Matcher>();

export function watchPathProblem(raw: string): string | null {
  const body = raw.startsWith('!') ? raw.slice(1) : raw;
  if (body.length > MAX_WATCH_PATH_LENGTH) {
    return `Watch path is longer than ${MAX_WATCH_PATH_LENGTH} characters`;
  }
  const segments = body.split('/');
  if (segments.length > MAX_WATCH_PATH_SEGMENTS) {
    return `Watch path has more than ${MAX_WATCH_PATH_SEGMENTS} segments`;
  }
  if (segments.filter((segment) => segment === '**').length > MAX_WATCH_PATH_GLOBSTARS) {
    return `Watch path has more than ${MAX_WATCH_PATH_GLOBSTARS} ** segments`;
  }
  if (body.split('{').length - 1 > MAX_WATCH_PATH_BRACES) {
    return `Watch path has more than ${MAX_WATCH_PATH_BRACES} brace groups`;
  }
  if (BRACE_RANGE.test(body)) return 'Watch path brace ranges are not supported';
  return null;
}

function buildMatcher(pattern: string): Matcher {
  const expanded = pattern.endsWith('/') ? `${pattern}**` : pattern;

  if (!GLOB_CHARS.test(expanded)) {
    return (path) => path === expanded || path.startsWith(`${expanded}/`);
  }

  const mm = new Minimatch(expanded, {
    dot: true,
    nobrace: watchPathProblem(expanded) !== null,
    noext: true,
    nonegate: true,
    nocomment: true
  });
  return (path) => mm.match(path);
}

function compile(pattern: string): Matcher {
  const cached = matcherCache.get(pattern);
  if (cached) return cached;
  const built = buildMatcher(pattern);
  if (matcherCache.size > 1000) matcherCache.clear();
  matcherCache.set(pattern, built);
  return built;
}

export function fileMatchesWatchPaths(file: string, patterns: string[]): boolean {
  const path = normalizeWatchPath(file);
  if (!path || path.length > MAX_MATCHED_PATH_LENGTH) return false;

  let hasInclude = false;
  let included = false;

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (compile(pattern.slice(1))(path)) return false;
      continue;
    }
    hasInclude = true;
    if (!included && compile(pattern)(path)) included = true;
  }

  return hasInclude ? included : true;
}

export function changedFilesFromPush(body: any): string[] | null {
  const commits: any[] = Array.isArray(body?.commits) ? body.commits : [];
  const head = body?.head_commit;

  if (commits.length >= PUSH_COMMIT_PAYLOAD_LIMIT) return null;

  const sources =
    head && !commits.some((commit) => commit?.id === head.id) ? [...commits, head] : commits;
  if (sources.length === 0) return null;

  const files = new Set<string>();
  for (const commit of sources) {
    for (const key of ['added', 'removed', 'modified'] as const) {
      const list = commit?.[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== 'string') continue;
        const normalized = normalizeWatchPath(entry);
        if (normalized) files.add(normalized);
      }
    }
  }

  return files.size > 0 ? [...files] : null;
}

export function pushMatchesWatchPaths(patterns: string[], files: string[] | null): boolean {
  const normalized = normalizeWatchPaths(patterns);
  if (normalized.length === 0) return true;
  if (!files || files.length === 0) return true;
  return files.some((file) => fileMatchesWatchPaths(file, normalized));
}

/**
 * Changed files from a compare response, or null when it cannot be trusted.
 *
 * `previous_filename` counts as well: a file renamed out of a watched
 * directory changed that directory, and the push payload reports the same move
 * as an add plus a remove, so this keeps the two sources saying the same thing.
 */
export function changedFilesFromCompare(body: any): string[] | null {
  const entries: any[] = Array.isArray(body?.files) ? body.files : [];
  if (entries.length === 0 || entries.length >= COMPARE_FILE_LIMIT) return null;

  const files = new Set<string>();
  for (const entry of entries) {
    for (const key of ['filename', 'previous_filename'] as const) {
      const value = entry?.[key];
      if (typeof value !== 'string') continue;
      const normalized = normalizeWatchPath(value);
      if (normalized) files.add(normalized);
    }
  }
  return files.size > 0 ? [...files] : null;
}

/**
 * Split deployments into the ones this file list says to build and the ones it
 * says to skip.
 *
 * Kept separate rather than filtered in place because the two halves carry
 * different weight: a file list that matches has proved something, and a file
 * list that does not has only failed to, which is not the same thing when the
 * list itself may be incomplete.
 */
export function partitionByWatchPaths<T extends { autoDeployPaths: unknown }>(
  deployments: T[],
  files: string[] | null
): { watched: T[]; unmatched: T[] } {
  const watched: T[] = [];
  const unmatched: T[] = [];
  for (const deployment of deployments) {
    const paths = Array.isArray(deployment.autoDeployPaths) ? deployment.autoDeployPaths : [];
    if (pushMatchesWatchPaths(paths as string[], files)) watched.push(deployment);
    else unmatched.push(deployment);
  }
  return { watched, unmatched };
}
