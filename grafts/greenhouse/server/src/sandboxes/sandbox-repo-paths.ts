import { posix } from 'path';
import {
  HOME_ROOT,
  homeGuard,
  MAX_FS_PATH_LENGTH,
  isValidRepoName,
  shellQuote
} from './sandbox-session-commands';

export const REPO_PATH_EXIT = {
  exists: 4,
  forbidden: 5,
  busy: 6,
  missing: 7,
  notDirectory: 8,
  alreadyProject: 9,
  insideRepo: 10,
  notWritable: 11,
  gitFailed: 12
} as const;

export const MAX_DIR_ENTRIES = 500;

const KEY_MAX = 60;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeMachinePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_FS_PATH_LENGTH) return null;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  const expanded =
    raw === '~' ? HOME_ROOT : raw.startsWith('~/') ? `${HOME_ROOT}${raw.slice(1)}` : raw;
  if (!expanded.startsWith('/')) return null;
  const normalized = posix.normalize(expanded);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function isProjectName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 63 &&
    REPO_NAME_RE.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.lock')
  );
}

export function repoKeyBase(path: string): string {
  const base = posix.basename(path);
  const key = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\.lock$/, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, KEY_MAX)
    .replace(/[-.]+$/, '');
  return key || 'project';
}

const pathRules = (home: string) => [
  ...homeGuard(home),
  'path_ok() { case "$1" in /|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|"$__home") return 1 ;; "$__home"/.*) return 1 ;; esac; return 0; }',
  `pick_key() { k="$1"; i=2; while [ -e "$__home/$k" ] || [ -L "$__home/$k" ]; do k="$1-$i"; i=$((i+1)); done; printf '%s' "$k"; }`
];

function resolveExisting(path: string, variable: string): string[] {
  return [
    `${variable}=$(realpath -e -- ${shellQuote(path)} 2>/dev/null) || exit ${REPO_PATH_EXIT.missing}`,
    `[ -d "$${variable}" ] || exit ${REPO_PATH_EXIT.notDirectory}`,
    `path_ok "$${variable}" || exit ${REPO_PATH_EXIT.forbidden}`
  ];
}

function resolveLocation(location: string, home: string): string[] {
  return [
    ...pathRules(home),
    `l=$(realpath -m -- ${shellQuote(location)} 2>/dev/null) || exit ${REPO_PATH_EXIT.forbidden}`,
    `path_ok "$l" || [ "$l" = "$__home" ] || exit ${REPO_PATH_EXIT.forbidden}`,
    `mkdir -p -- "$l" 2>/dev/null || exit ${REPO_PATH_EXIT.notWritable}`,
    `l=$(realpath -e -- "$l") || exit ${REPO_PATH_EXIT.missing}`,
    `path_ok "$l" || [ "$l" = "$__home" ] || exit ${REPO_PATH_EXIT.forbidden}`,
    `[ -w "$l" ] || exit ${REPO_PATH_EXIT.notWritable}`
  ];
}

function keyFor(target: string, name: string): string[] {
  return [
    `if [ "$(dirname -- "${target}")" = "$__home" ]; then k=${shellQuote(name)}; else k=$(pick_key ${shellQuote(name)}); fi`
  ];
}

function linkLine(target: string): string {
  return `[ "$__home/$k" = "${target}" ] || ln -s -- "${target}" "$__home/$k"`;
}

export function printedKey(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('KEY:'));
  const key = line?.slice(4) ?? '';
  return isValidRepoName(key) ? key : null;
}

export interface CloneToLocationInput {
  location: string;
  name: string;
  git: string;
  url: string;
  preflightSeconds: number;
  home?: string;
}

export function buildCloneToLocationScript(input: CloneToLocationInput): string {
  if (!isProjectName(input.name)) throw new Error('invalid name');
  const url = shellQuote(input.url);
  return [
    ...resolveLocation(input.location, input.home ?? HOME_ROOT),
    `t="$l"/${shellQuote(input.name)}`,
    `[ -e "$t" ] || [ -L "$t" ] && exit ${REPO_PATH_EXIT.exists}`,
    `s="$l"/${shellQuote(`.${input.name}.orchard-clone`)}`,
    `[ -e "$s" ] && exit ${REPO_PATH_EXIT.busy}`,
    ...keyFor('$t', input.name),
    `out=$(timeout ${input.preflightSeconds} ${input.git} ls-remote --heads ${url} 2>&1 >/dev/null) || { printf '%s\\n' "$out" | tail -n 5; exit 13; }`,
    `( trap '' HUP; ${input.git} clone ${url} "$s" && mv -T -- "$s" "$t" && { ${linkLine('$t')}; } || rm -rf -- "$s" ) >> "$__home/.clone.log" 2>&1 < /dev/null &`,
    `printf 'KEY:%s\\n' "$k"`,
    'exit 0'
  ].join('\n');
}

export function buildInitAtLocationScript(
  location: string,
  name: string,
  home: string = HOME_ROOT
): string {
  if (!isProjectName(name)) throw new Error('invalid name');
  return [
    ...resolveLocation(location, home),
    `t="$l"/${shellQuote(name)}`,
    `[ -e "$t" ] || [ -L "$t" ] && exit ${REPO_PATH_EXIT.exists}`,
    ...keyFor('$t', name),
    `mkdir -- "$t" || exit ${REPO_PATH_EXIT.notWritable}`,
    `{ git -C "$t" init -q -b main && git -C "$t" commit -q --allow-empty -m 'Initial commit'; } 2>&1 || { rm -rf -- "$t"; exit ${REPO_PATH_EXIT.gitFailed}; }`,
    linkLine('$t'),
    `printf 'KEY:%s\\n' "$k"`
  ].join('\n');
}

export function buildLinkFolderScript(path: string, home: string = HOME_ROOT): string {
  return [
    ...pathRules(home),
    ...resolveExisting(path, 'p'),
    `if [ "$(dirname -- "$p")" = "$__home" ] && [ -e "$p/.git" ]; then printf 'KEY:%s\\n' "\${p##*/}"; exit ${REPO_PATH_EXIT.alreadyProject}; fi`,
    `for l in "$__home"/*; do [ -L "$l" ] && [ "$(realpath -e -- "$l" 2>/dev/null)" = "$p" ] && { printf 'KEY:%s\\n' "\${l##*/}"; exit ${REPO_PATH_EXIT.alreadyProject}; }; done`,
    `top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null)`,
    `if [ -n "$top" ] && [ "$(realpath -e -- "$top")" != "$p" ]; then printf 'TOP:%s\\n' "$top"; exit ${REPO_PATH_EXIT.insideRepo}; fi`,
    `[ -w "$p" ] || exit ${REPO_PATH_EXIT.notWritable}`,
    `[ -n "$top" ] || git -C "$p" init -q -b main 2>&1 || exit ${REPO_PATH_EXIT.gitFailed}`,
    `if ! git -C "$p" rev-parse -q --verify HEAD >/dev/null 2>&1; then out=$( { git -C "$p" add -A && git -C "$p" commit -q --allow-empty -m 'Initial commit'; } 2>&1) || { printf '%s\\n' "$out" | tail -n 5; exit ${REPO_PATH_EXIT.gitFailed}; }; fi`,
    `n=\${p##*/}`,
    `if [ "$(dirname -- "$p")" = "$__home" ] && printf '%s' "$n" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then k=$n; else k=$(pick_key ${shellQuote(repoKeyBase(path))}); ln -s -- "$p" "$__home/$k" || exit ${REPO_PATH_EXIT.notWritable}; fi`,
    `printf 'KEY:%s\\n' "$k"`
  ].join('\n');
}

export function printedTop(stdout: string): string | null {
  const line = stdout.split('\n').find((l) => l.startsWith('TOP:'));
  return line ? line.slice(4).trim() || null : null;
}

export function buildListDirsScript(path: string): string {
  return [
    "e() { printf '%s' \"$1\" | base64 | tr -d '\\n'; }",
    `p=${shellQuote(path)}`,
    `[ -e "$p" ] || exit ${REPO_PATH_EXIT.missing}`,
    `[ -d "$p" ] || exit ${REPO_PATH_EXIT.notDirectory}`,
    `[ -r "$p" ] && [ -x "$p" ] || exit ${REPO_PATH_EXIT.forbidden}`,
    'g=0; [ -e "$p/.git" ] && g=1',
    `printf '%s|%s\\n' "$(e "$p")" "$g"`,
    `for d in "$p"/*; do [ -d "$d" ] || continue; g=0; [ -e "$d/.git" ] && g=1; printf '%s|%s\\n' "$(e "\${d##*/}")" "$g"; done | head -n ${MAX_DIR_ENTRIES}`
  ].join('\n');
}

export interface MachineDirListing {
  path: string;
  parent: string | null;
  git: boolean;
  entries: Array<{ name: string; path: string; git: boolean }>;
  truncated: boolean;
}

function decode(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return Buffer.from(value, 'base64').toString('utf8');
}

export function parseDirListing(stdout: string): MachineDirListing | null {
  const lines = stdout.split('\n').filter((l) => l.trim());
  const head = lines.shift()?.trim().split('|');
  const path = head && head.length === 2 ? decode(head[0]) : null;
  if (!head || !path || !path.startsWith('/')) return null;
  const entries: MachineDirListing['entries'] = [];
  for (const line of lines) {
    const [raw, git] = line.trim().split('|');
    const name = raw ? decode(raw) : null;
    if (!name || name.includes('/') || name.startsWith('.')) continue;
    entries.push({ name, path: posix.join(path, name), git: git === '1' });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path,
    parent: path === '/' ? null : posix.dirname(path),
    git: head[1] === '1',
    entries,
    truncated: lines.length >= MAX_DIR_ENTRIES
  };
}
