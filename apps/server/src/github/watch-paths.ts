export const MAX_WATCH_PATHS = 50;

export const MAX_WATCH_PATH_LENGTH = 500;

const PUSH_COMMIT_PAYLOAD_LIMIT = 2048;

// The compare endpoint reports at most 300 files, so a response sitting on the
// cap is a truncation rather than an answer.
const COMPARE_FILE_LIMIT = 300;

const GLOB_CHARS = /[*?[\]{}]/;

const regexCache = new Map<string, RegExp>();

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

function escapeLiteral(ch: string): string {
  return /[.+^$(){}|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

function segmentToRegex(segment: string): string {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      out += '(?:';
      braceDepth += 1;
    } else if (ch === '}' && braceDepth > 0) {
      out += ')';
      braceDepth -= 1;
    } else if (ch === ',' && braceDepth > 0) {
      out += '|';
    } else if (ch === '[' && segment.indexOf(']', i + 2) > i) {
      const close = segment.indexOf(']', i + 2);
      const body = segment.slice(i + 1, close).replace(/\\/g, '\\\\');
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = close;
    } else {
      out += escapeLiteral(ch);
    }
  }
  while (braceDepth > 0) {
    out += ')';
    braceDepth -= 1;
  }
  return out;
}

function buildRegex(pattern: string): RegExp {
  const expanded = pattern.endsWith('/') ? `${pattern}**` : pattern;

  if (!GLOB_CHARS.test(expanded)) {
    const literal = expanded.split('').map(escapeLiteral).join('');
    return new RegExp(`^${literal}(?:/.*)?$`);
  }

  const segments = expanded.split('/');
  let source = '^';
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      source += isLast ? '.*' : '(?:[^/]+/)*';
      return;
    }
    source += segmentToRegex(segment);
    if (!isLast) source += '/';
  });
  return new RegExp(`${source}$`);
}

function compile(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const built = buildRegex(pattern);
  if (regexCache.size > 1000) regexCache.clear();
  regexCache.set(pattern, built);
  return built;
}

export function fileMatchesWatchPaths(file: string, patterns: string[]): boolean {
  const path = normalizeWatchPath(file);
  if (!path) return false;

  let hasInclude = false;
  let included = false;

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (compile(pattern.slice(1)).test(path)) return false;
      continue;
    }
    hasInclude = true;
    if (!included && compile(pattern).test(path)) included = true;
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
  files: string[] | null,
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
