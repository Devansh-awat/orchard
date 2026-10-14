import { posix } from 'path';
import {
  MAX_DECLARED_PREVIEW_PORTS,
  RESERVED_SANDBOX_PORTS,
  isDeclarablePreviewPort
} from './preview/preview-auth';

export const HOME_ROOT = '/persist/home';
export const WORKTREES_ROOT = `${HOME_ROOT}/.worktrees`;
export const SESSION_STATE_ROOT = `${HOME_ROOT}/.orchard/sessions`;
export const SESSION_BRANCH_PREFIX = 'orchard';
export const MAX_BRANCH_PREFIX = 40;
export const GREENHOUSE_CONFIG_PATH = '.orchard/greenhouse.json';
export const MAX_GREENHOUSE_CONFIG_BYTES = 65536;
export const MAX_SCRIPT_LENGTH = 65536;
export const MAX_CONFIG_PORTS = MAX_DECLARED_PREVIEW_PORTS;
export const MAX_FS_PATH_LENGTH = 1024;

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_CHAR_RE = /^[A-Za-z0-9._/+-]+$/;
const PREFIX_CHAR_RE = /^[A-Za-z0-9._/-]+$/;
const TERMINAL_INDEX_RE = /^(?:\d{1,2}|setup|run)$/;
const SHORTSTAT_FILES_RE = /(\d+) files? changed/;
const SHORTSTAT_ADD_RE = /(\d+) insertions?\(\+\)/;
const SHORTSTAT_DEL_RE = /(\d+) deletions?\(-\)/;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isValidRepoName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 120 &&
    REPO_RE.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.lock')
  );
}

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value) && !value.includes('--');
}

export function isValidGitRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 200) return false;
  if (!REF_CHAR_RE.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.') || value.includes('..') || value.includes('//')) return false;
  if (value === '@' || value.includes('@{')) return false;
  for (const part of value.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

export function isValidBranchPrefix(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.length > MAX_BRANCH_PREFIX || !PREFIX_CHAR_RE.test(value)) return false;
  if (value.startsWith('-') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('@{')) return false;
  for (const part of value.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

export function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const tail = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  const slug = [base || 'session', tail].filter(Boolean).join('-');
  return slug.replace(/-{2,}/g, '-');
}

export function sessionBranch(slug: string, prefix: string = SESSION_BRANCH_PREFIX): string {
  return prefix ? `${prefix}/${slug}` : slug;
}

function checkedBranch(slug: string, branch: string | null | undefined): string {
  const name = branch ?? sessionBranch(slug);
  if (!isValidGitRef(name)) throw new Error('invalid branch');
  return name;
}

export function worktreePathFor(repo: string, slug: string): string {
  return `${WORKTREES_ROOT}/${repo}/${slug}`;
}

export function repoPathFor(repo: string): string {
  return `${HOME_ROOT}/${repo}`;
}

export function isWorktreePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 500) return false;
  if (!path.startsWith(`${WORKTREES_ROOT}/`)) return false;
  if (path.includes('\0') || path.includes('//')) return false;
  if (posix.normalize(path) !== path) return false;
  const rest = path.slice(WORKTREES_ROOT.length + 1).split('/');
  return rest.length === 2 && isValidRepoName(rest[0]) && isValidSlug(rest[1]);
}

export function sessionShortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

export function tmuxSessionName(sessionId: string, index: string): string {
  return `orchard-${sessionShortId(sessionId)}-${index}`;
}

export function sessionStateDir(sessionId: string): string {
  return `${SESSION_STATE_ROOT}/${sessionId.toLowerCase()}`;
}

export function isTerminalIndex(value: unknown): value is string {
  return typeof value === 'string' && TERMINAL_INDEX_RE.test(value);
}

export function realpathGuard(dirVar: string, rootPath: string, failCode: number): string {
  return [
    `__root=$(realpath -e -- ${shellQuote(rootPath)} 2>/dev/null) || exit ${failCode}`,
    `__dir=$(realpath -e -- "${dirVar}" 2>/dev/null) || exit ${failCode}`,
    `case "$__dir/" in "$__root"/*) ;; *) exit ${failCode} ;; esac`
  ].join('; ');
}

export interface WorktreeAddInput {
  repo: string;
  slug: string;
  baseBranch: string | null;
  branch?: string | null;
  extra?: string;
}

export interface WorktreeAddResult {
  baseBranch: string | null;
  baseCommit: string | null;
  hookInstalled: boolean;
}

export const WORKTREE_EXIT = {
  notRepo: 3,
  exists: 4,
  noBase: 5,
  addFailed: 6
} as const;

export function buildWorktreeAddScript(input: WorktreeAddInput): string {
  if (!isValidRepoName(input.repo)) throw new Error('invalid repo');
  if (!isValidSlug(input.slug)) throw new Error('invalid slug');
  if (input.baseBranch !== null && !isValidGitRef(input.baseBranch)) {
    throw new Error('invalid base branch');
  }
  const repo = shellQuote(repoPathFor(input.repo));
  const parent = shellQuote(`${WORKTREES_ROOT}/${input.repo}`);
  const path = shellQuote(worktreePathFor(input.repo, input.slug));
  const branch = shellQuote(checkedBranch(input.slug, input.branch));
  return [
    `git -C ${repo} rev-parse --git-dir >/dev/null 2>&1 || exit ${WORKTREE_EXIT.notRepo}`,
    `[ -e ${path} ] && exit ${WORKTREE_EXIT.exists}`,
    input.baseBranch
      ? `base=${shellQuote(input.baseBranch)}`
      : `base=$(git -C ${repo} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); [ -n "$base" ] || base=$(git -C ${repo} rev-parse --abbrev-ref HEAD 2>/dev/null)`,
    `[ -n "$base" ] && [ "$base" != HEAD ] || exit ${WORKTREE_EXIT.noBase}`,
    `if ! git -C ${repo} rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}" >/dev/null; then GIT_TERMINAL_PROMPT=0 timeout 10 git -C ${repo} fetch --quiet origin "$base" >/dev/null 2>&1 || true; fetched=1; fi`,
    `if git -C ${repo} rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}" >/dev/null; then start="origin/$base"; elif git -C ${repo} rev-parse --verify --quiet "$base^{commit}" >/dev/null; then start="$base"; else exit ${WORKTREE_EXIT.noBase}; fi`,
    `mkdir -p ${parent} || exit ${WORKTREE_EXIT.addFailed}`,
    `git -C ${repo} worktree add --quiet --no-track -b ${branch} ${path} "$start" >&2 || exit ${WORKTREE_EXIT.addFailed}`,
    `printf '@@base@@%s\\n' "$base"`,
    `printf '@@commit@@%s\\n' "$(git -C ${path} rev-parse HEAD)"`,
    ...(input.extra ? [input.extra] : []),
    `[ -n "$fetched" ] || (GIT_TERMINAL_PROMPT=0 $(command -v setsid) nohup timeout 60 git -C ${repo} fetch --quiet origin "$base" </dev/null >/dev/null 2>&1 &)`,
    'exit 0'
  ].join('\n');
}

export function parseWorktreeAddOutput(stdout: string): WorktreeAddResult {
  const base = stdout.match(/@@base@@(.*)/)?.[1]?.trim() || null;
  const commit = stdout.match(/@@commit@@([0-9a-f]{7,64})/)?.[1] ?? null;
  return { baseBranch: base, baseCommit: commit, hookInstalled: stdout.includes('@@hook@@ok') };
}

export function buildWorktreeRestoreScript(
  repo: string,
  slug: string,
  branch: string | null = null
): string {
  if (!isValidRepoName(repo) || !isValidSlug(slug)) throw new Error('invalid session');
  const name = checkedBranch(slug, branch);
  const repoPath = shellQuote(repoPathFor(repo));
  const path = shellQuote(worktreePathFor(repo, slug));
  return [
    `git -C ${repoPath} rev-parse --git-dir >/dev/null 2>&1 || exit ${WORKTREE_EXIT.notRepo}`,
    `[ -e ${path} ] && exit 0`,
    `git -C ${repoPath} worktree prune >/dev/null 2>&1`,
    `mkdir -p ${shellQuote(`${WORKTREES_ROOT}/${repo}`)}`,
    `git -C ${repoPath} worktree add --quiet ${path} ${shellQuote(name)} >&2 || exit ${WORKTREE_EXIT.addFailed}`
  ].join('\n');
}

export function buildWorktreeRemoveScript(
  repo: string,
  slug: string,
  sessionId: string,
  opts: { deleteBranch?: boolean; purgeState?: boolean; branch?: string | null } = {}
): string {
  if (!isValidRepoName(repo) || !isValidSlug(slug)) throw new Error('invalid session');
  const branch = checkedBranch(slug, opts.branch);
  const repoPath = shellQuote(repoPathFor(repo));
  const path = shellQuote(worktreePathFor(repo, slug));
  const lines = [
    killSessionTmuxScript(sessionId),
    `if [ -e ${path} ]; then git -C ${repoPath} worktree remove --force ${path} >&2 || rm -rf -- ${path}; fi`,
    `git -C ${repoPath} worktree prune >/dev/null 2>&1 || true`
  ];
  if (opts.deleteBranch) {
    lines.push(`git -C ${repoPath} branch -D ${shellQuote(branch)} >&2 2>/dev/null || true`);
  }
  if (opts.purgeState) lines.push(`rm -rf -- ${shellQuote(sessionStateDir(sessionId))}`);
  lines.push('exit 0');
  return lines.join('\n');
}

export function buildRepoRemoveScript(repo: string): string {
  if (!isValidRepoName(repo)) throw new Error('invalid repo');
  const repoPath = shellQuote(repoPathFor(repo));
  const worktrees = shellQuote(`${WORKTREES_ROOT}/${repo}`);
  return [
    `[ -e ${repoPath}/.git ] || exit 4`,
    `rm -rf -- ${worktrees} ${repoPath}`,
    `[ ! -e ${repoPath} ]`
  ].join('\n');
}

export function killSessionTmuxScript(sessionId: string): string {
  const prefix = `orchard-${sessionShortId(sessionId)}-`;
  return `command -v tmux >/dev/null 2>&1 && tmux ls -F '#{session_name}' 2>/dev/null | grep -F -- ${shellQuote(prefix)} | while read -r s; do case "$s" in ${shellQuote(prefix)}*) tmux kill-session -t "=$s" 2>/dev/null ;; esac; done; true`;
}

export interface GreenhouseConfig {
  setup: string | null;
  run: string | null;
  ports: number[];
}

export const EMPTY_GREENHOUSE_CONFIG: GreenhouseConfig = { setup: null, run: null, ports: [] };

function scriptField(raw: unknown): string | null {
  let value = raw;
  if (Array.isArray(raw)) {
    if (!raw.every((line) => typeof line === 'string')) return null;
    value = raw.join('\n');
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SCRIPT_LENGTH || trimmed.includes('\0')) return null;
  return trimmed;
}

export function parseGreenhouseConfig(text: string | null | undefined): GreenhouseConfig {
  if (!text || !text.trim()) return { ...EMPTY_GREENHOUSE_CONFIG, ports: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_GREENHOUSE_CONFIG, ports: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_GREENHOUSE_CONFIG, ports: [] };
  }
  const obj = raw as Record<string, unknown>;
  const ports: number[] = [];
  if (Array.isArray(obj.ports)) {
    for (const value of obj.ports) {
      const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      if (!isDeclarablePreviewPort(port)) continue;
      if (!ports.includes(port)) ports.push(port);
      if (ports.length >= MAX_CONFIG_PORTS) break;
    }
  }
  return { setup: scriptField(obj.setup), run: scriptField(obj.run), ports };
}

export interface DiffstatTarget {
  id: string;
  worktreePath: string;
  baseBranch: string | null;
  baseCommit: string | null;
}

export interface SessionGitStats {
  diffstat: { files: number; additions: number; deletions: number } | null;
  aheadBehind: { ahead: number; behind: number } | null;
}

export function buildDiffstatBatchScript(targets: DiffstatTarget[]): string {
  const lines: string[] = [];
  for (const t of targets) {
    if (!isUuid(t.id) || !isWorktreePath(t.worktreePath)) continue;
    const base = t.baseBranch && isValidGitRef(t.baseBranch) ? t.baseBranch : null;
    const commit = t.baseCommit && /^[0-9a-f]{7,64}$/.test(t.baseCommit) ? t.baseCommit : null;
    const dir = shellQuote(t.worktreePath);
    const upstream = base
      ? `u=; git -C ${dir} rev-parse --verify --quiet ${shellQuote(`refs/remotes/origin/${base}^{commit}`)} >/dev/null && u=${shellQuote(`origin/${base}`)}; [ -n "$u" ] || u=${commit ? shellQuote(commit) : '""'}`
      : `u=${commit ? shellQuote(commit) : '""'}`;
    lines.push(
      `printf '@@s %s\\n' ${shellQuote(t.id)}`,
      `if [ -d ${dir} ]; then`,
      `  ${upstream}`,
      `  if [ -n "$u" ]; then`,
      `    mb=$(git -C ${dir} merge-base HEAD "$u" 2>/dev/null || echo "$u")`,
      `    printf '@@d '; git -C ${dir} diff --shortstat "$mb" 2>/dev/null; echo`,
      `    printf '@@u %s\\n' "$(git -C ${dir} ls-files --others --exclude-standard 2>/dev/null | wc -l)"`,
      `    printf '@@ab %s\\n' "$(git -C ${dir} rev-list --left-right --count "$u...HEAD" 2>/dev/null | tr '\\t' ' ')"`,
      '  fi',
      'fi'
    );
  }
  return lines.join('\n');
}

export function parseShortstat(line: string): {
  files: number;
  additions: number;
  deletions: number;
} {
  return {
    files: Number(line.match(SHORTSTAT_FILES_RE)?.[1] ?? 0),
    additions: Number(line.match(SHORTSTAT_ADD_RE)?.[1] ?? 0),
    deletions: Number(line.match(SHORTSTAT_DEL_RE)?.[1] ?? 0)
  };
}

export function parseDiffstatBatch(stdout: string): Map<string, SessionGitStats> {
  const out = new Map<string, SessionGitStats>();
  let current: SessionGitStats | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@s ')) {
      const id = line.slice(4).trim();
      if (!isUuid(id)) {
        current = null;
        continue;
      }
      current = { diffstat: null, aheadBehind: null };
      out.set(id.toLowerCase(), current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@d')) {
      current.diffstat = parseShortstat(line.slice(3));
      continue;
    }
    if (line.startsWith('@@u ')) {
      const untracked = Number(line.slice(4).trim());
      if (Number.isFinite(untracked) && untracked > 0) {
        current.diffstat = current.diffstat ?? { files: 0, additions: 0, deletions: 0 };
        current.diffstat.files += untracked;
      }
      continue;
    }
    if (line.startsWith('@@ab ')) {
      const m = line
        .slice(5)
        .trim()
        .match(/^(\d+)\s+(\d+)$/);
      if (m) current.aheadBehind = { behind: Number(m[1]), ahead: Number(m[2]) };
      continue;
    }
    if (current.diffstat && SHORTSTAT_FILES_RE.test(line)) {
      current.diffstat = parseShortstat(line);
    }
  }
  return out;
}

export function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_FS_PATH_LENGTH) return null;
  if (value.includes('\0') || /[\r\n]/.test(value)) return null;
  if (value.startsWith('/') || value.startsWith('~')) return null;
  const normalized = posix.normalize(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../') || normalized.split('/').includes('..')) return null;
  if (normalized.startsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.includes('.git')) return null;
  return normalized;
}

export const READ_EXIT = {
  outside: 5,
  missing: 7,
  notFile: 8
} as const;

function homeGuard(home: string): string[] {
  return [
    `__home=$(realpath -e -- ${shellQuote(home)} 2>/dev/null) || exit ${READ_EXIT.outside}`,
    'home_ok() { case "$1/" in "$__home"/.worktrees/?*/?*) return 0 ;; "$__home"/.*) return 1 ;; esac; return 0; }'
  ];
}

export const HOME_GUARD = homeGuard(HOME_ROOT);

function confinedRoot(root: string): string[] {
  return [
    ...HOME_GUARD,
    `__root=$(realpath -e -- ${shellQuote(root)} 2>/dev/null) || exit ${READ_EXIT.outside}`,
    `case "$__root/" in "$__home"/*) ;; *) exit ${READ_EXIT.outside} ;; esac`,
    `home_ok "$__root" || exit ${READ_EXIT.outside}`
  ];
}

export function buildConfinedReadScript(root: string, file: string, maxBytes: number): string {
  const rel = normalizeRelativePath(file);
  if (!rel) throw new Error('invalid path');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('invalid size');
  return [
    ...confinedRoot(root),
    `t=$(realpath -e -- "$__root"/${shellQuote(rel)} 2>/dev/null) || exit ${READ_EXIT.missing}`,
    `case "$t/" in "$__root"/*) ;; *) exit ${READ_EXIT.outside} ;; esac`,
    `home_ok "$t" || exit ${READ_EXIT.outside}`,
    `[ -f "$t" ] || exit ${READ_EXIT.notFile}`,
    `head -c ${maxBytes + 1} -- "$t" | base64 | tr -d '\\n'`
  ].join('\n');
}

export function buildConfinedPathCheck(root: string, file: string): string {
  const rel = normalizeRelativePath(file);
  if (!rel) throw new Error('invalid path');
  return [
    ...confinedRoot(root),
    `t=$(realpath -m -- "$__root"/${shellQuote(rel)} 2>/dev/null) || exit ${READ_EXIT.outside}`,
    `case "$t/" in "$__root"/*) ;; *) exit ${READ_EXIT.outside} ;; esac`,
    `home_ok "$t" || exit ${READ_EXIT.outside}`
  ].join('; ');
}

export type FsOp = 'mkdir' | 'rename' | 'delete';

export const FS_EXIT = {
  outside: 5,
  exists: 6,
  missing: 7,
  failed: 8
} as const;

const fsPrelude = (home: string) => [
  ...homeGuard(home),
  'inside() { case "$1/" in "$__root"/*) home_ok "$1"; return $? ;; esac; return 1; }',
  'resolve_parent() { p=$(dirname -- "$1"); b=$(basename -- "$1"); rp=$(realpath -e -- "$p" 2>/dev/null) || return 1; inside "$rp" || return 1; home_ok "$rp/$b" || return 1; printf "%s/%s" "$rp" "$b"; }',
  'resolve_new() { r=$(realpath -m -- "$1" 2>/dev/null) || return 1; inside "$r" || return 1; [ "$r" != "$__root" ] || return 1; printf "%s" "$r"; }'
];

export function buildFsScript(
  op: FsOp,
  root: string,
  guardRoot: string,
  path: string,
  to?: string,
  home: string = HOME_ROOT
): string {
  const rel = normalizeRelativePath(path);
  if (!rel) throw new Error('invalid path');
  const lines = [
    `__guard=$(realpath -e -- ${shellQuote(guardRoot)} 2>/dev/null) || exit ${FS_EXIT.outside}`,
    `__root=$(realpath -e -- ${shellQuote(root)} 2>/dev/null) || exit ${FS_EXIT.outside}`,
    `case "$__root/" in "$__guard"/*) ;; *) exit ${FS_EXIT.outside} ;; esac`,
    ...fsPrelude(home),
    `target="$__root"/${shellQuote(rel)}`
  ];
  if (op === 'mkdir') {
    lines.push(
      `t=$(resolve_new "$target") || exit ${FS_EXIT.outside}`,
      `[ -e "$t" ] && exit ${FS_EXIT.exists}`,
      `mkdir -p -- "$t" || exit ${FS_EXIT.failed}`
    );
  } else if (op === 'delete') {
    lines.push(
      `t=$(resolve_parent "$target") || exit ${FS_EXIT.outside}`,
      `[ "$t" != "$__root" ] || exit ${FS_EXIT.outside}`,
      `[ -e "$t" ] || [ -L "$t" ] || exit ${FS_EXIT.missing}`,
      `rm -rf -- "$t" || exit ${FS_EXIT.failed}`
    );
  } else {
    const dest = normalizeRelativePath(to);
    if (!dest) throw new Error('invalid destination');
    lines.push(
      `dest="$__root"/${shellQuote(dest)}`,
      `s=$(resolve_parent "$target") || exit ${FS_EXIT.outside}`,
      `[ "$s" != "$__root" ] || exit ${FS_EXIT.outside}`,
      `[ -e "$s" ] || [ -L "$s" ] || exit ${FS_EXIT.missing}`,
      `dp=$(realpath -m -- "$(dirname -- "$dest")" 2>/dev/null) || exit ${FS_EXIT.outside}`,
      `inside "$dp" || exit ${FS_EXIT.outside}`,
      `mkdir -p -- "$dp" 2>/dev/null`,
      `d=$(resolve_parent "$dest") || exit ${FS_EXIT.outside}`,
      `[ -e "$d" ] || [ -L "$d" ] && exit ${FS_EXIT.exists}`,
      `mv -T -- "$s" "$d" || exit ${FS_EXIT.failed}`
    );
  }
  return lines.join('\n');
}

export interface ListeningSocket {
  port: number;
  inode: string;
  loopback: boolean;
}

export interface SandboxPort {
  port: number;
  process: string | null;
  pid: number | null;
  inSession: boolean;
  loopbackOnly: boolean;
}

export const IGNORED_PORTS = new Set(RESERVED_SANDBOX_PORTS);

export function buildPortsScript(): string {
  return [
    'u=$(id -u dev 2>/dev/null) || exit 0',
    "echo '@@home@@'",
    `realpath -e -- ${shellQuote(HOME_ROOT)} 2>/dev/null`,
    "echo '@@listen@@'",
    'for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && awk \'NR>1 && $4=="0A" {print $2, $10}\' "$f"; done',
    "echo '@@sock@@'",
    'pids=$(find /proc -mindepth 1 -maxdepth 1 -name "[0-9]*" -user "$u" 2>/dev/null)',
    '[ -n "$pids" ] || exit 0',
    'for p in $pids; do find "$p/fd" -mindepth 1 -maxdepth 1 -lname "socket:*" -printf "%h %l\\n" 2>/dev/null; done',
    "echo '@@proc@@'",
    'for p in $pids; do printf "%s %s %s\\t%s\\n" "${p#/proc/}" "$(readlink "$p/cwd" 2>/dev/null | tr " " "?")" "$(head -c 64 "$p/comm" 2>/dev/null | tr "\\t" " ")" "$(head -c 512 "$p/cmdline" 2>/dev/null | tr "\\000\\t\\n" "   ")"; done'
  ].join('\n');
}

const INFRA_NAME_RE =
  /^(?:opencode|sshd|tmux|orchard|gopls|rust-analyzer|clangd|zls|jdtls|sourcekit-lsp|omnisharp|solargraph|intelephense|svelteserver|tsserver(?:\.js)?|pyright[\w.-]*|[\w.-]*lang(?:uage)?[-_]?servers?[\w.-]*|[\w.-]+-lsp|[\w.-]+-ls)$/;
const INFRA_PATH_RE =
  /\/(?:\.cache\/opencode|\.local\/share\/opencode|\.opencode|node_modules\/opencode-ai|node_modules\/\.bin\/opencode)(?:\/|$)/;
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python3',
  'java',
  'ruby'
]);
const LSP_SUBCOMMANDS = new Set(['lsp', 'lsp-proxy']);

function baseNameOf(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

export function isInfrastructureProcess(comm: string | null, cmdline: string | null): boolean {
  const name = (comm ?? '').trim().split(' ')[0].replace(/:$/, '');
  if (name && INFRA_NAME_RE.test(name)) return true;
  const argv = (cmdline ?? '').trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return false;
  if (argv.some((arg) => INFRA_PATH_RE.test(arg))) return true;
  for (const arg of argv) {
    for (const m of arg.matchAll(/node_modules\/(?:@[^/\s]+\/)?([^/\s]+)/g)) {
      if (INFRA_NAME_RE.test(m[1])) return true;
    }
  }
  const exe = baseNameOf(argv[0]).replace(/:$/, '');
  if (INFRA_NAME_RE.test(exe)) return true;
  const rest = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  if (
    INTERPRETERS.has(exe.replace(/[\d.]+$/, '')) &&
    rest[0] &&
    INFRA_NAME_RE.test(baseNameOf(rest[0]))
  ) {
    return true;
  }
  return !!rest[0] && LSP_SUBCOMMANDS.has(rest[0]);
}

function hexAddrIsLoopback(addr: string): boolean {
  const hex = addr.split(':')[0] ?? '';
  if (hex.length === 8) return hex.endsWith('7F');
  if (hex.length === 32) {
    return hex === '00000000000000000000000001000000' || hex.endsWith('0100007F');
  }
  return false;
}

export function inWorktree(directory: unknown, worktreePath: string | null): boolean {
  if (typeof directory !== 'string' || !worktreePath) return false;
  if (directory === worktreePath) return true;
  if (!worktreePath.startsWith(`${HOME_ROOT}/`) || !directory.startsWith('/')) return false;
  return directory.endsWith(worktreePath.slice(HOME_ROOT.length));
}

function logicalHomePath(path: string, physicalHome: string | undefined): string {
  if (!physicalHome || physicalHome === HOME_ROOT || !physicalHome.startsWith('/')) return path;
  if (path !== physicalHome && !path.startsWith(`${physicalHome}/`)) return path;
  return `${HOME_ROOT}${path.slice(physicalHome.length)}`;
}

export function parsePortsOutput(stdout: string, worktreePath: string | null): SandboxPort[] {
  const sections: Record<string, string[]> = { home: [], listen: [], sock: [], proc: [] };
  let section: string | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const marker = line.match(/^@@(home|listen|sock|proc)@@$/);
    if (marker) {
      section = marker[1];
      continue;
    }
    if (section && line) sections[section].push(line);
  }
  const listening = new Map<string, ListeningSocket>();
  for (const line of sections.listen) {
    const [local, inode] = line.split(/\s+/);
    if (!local || !inode || inode === '0') continue;
    const portHex = local.split(':').pop() ?? '';
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    listening.set(inode, { port, inode, loopback: hexAddrIsLoopback(local) });
  }
  const pidByInode = new Map<string, number>();
  for (const line of sections.sock) {
    const m = line.match(/^\/proc\/(\d+)\/fd socket:\[(\d+)\]$/);
    if (m) pidByInode.set(m[2], Number(m[1]));
  }
  const procs = new Map<
    number,
    { cwd: string | null; comm: string | null; cmdline: string | null }
  >();
  for (const line of sections.proc) {
    const m = line.match(/^(\d+) (\S*) ?([^\t]*)(?:\t(.*))?$/);
    if (!m) continue;
    procs.set(Number(m[1]), {
      cwd: m[2] ? logicalHomePath(m[2].replace(/\?/g, ' '), sections.home[0]) : null,
      comm: m[3].trim() || null,
      cmdline: m[4]?.trim() || null
    });
  }
  const byPort = new Map<number, SandboxPort>();
  for (const [inode, sock] of listening) {
    const pid = pidByInode.get(inode);
    if (pid === undefined) continue;
    if (IGNORED_PORTS.has(sock.port)) continue;
    const proc = procs.get(pid);
    if (isInfrastructureProcess(proc?.comm ?? null, proc?.cmdline ?? null)) continue;
    const cwd = proc?.cwd ?? null;
    const inSession =
      !!worktreePath && !!cwd && (cwd === worktreePath || cwd.startsWith(`${worktreePath}/`));
    const existing = byPort.get(sock.port);
    if (existing) {
      existing.loopbackOnly = existing.loopbackOnly && sock.loopback;
      existing.inSession = existing.inSession || inSession;
      continue;
    }
    byPort.set(sock.port, {
      port: sock.port,
      process: proc?.comm ?? null,
      pid,
      inSession,
      loopbackOnly: sock.loopback
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export interface ScriptLaunch {
  name: 'setup' | 'run';
  sessionId: string;
  worktreePath: string;
  repoPath: string;
}

export function scriptFiles(launch: ScriptLaunch): {
  wrapperPath: string;
  userPath: string;
  wrapper: string;
} {
  const dir = sessionStateDir(launch.sessionId);
  const userPath = `${dir}/${launch.name}.user.sh`;
  const wrapperPath = `${dir}/${launch.name}.sh`;
  const channel = `${tmuxSessionName(launch.sessionId, launch.name)}-go`;
  const status = `${dir}/${launch.name}.status`;
  const lines = [
    '#!/bin/bash',
    `tmux wait-for ${shellQuote(channel)} 2>/dev/null`,
    `cd ${shellQuote(launch.worktreePath)} || exit 1`,
    `export ORCHARD_SESSION_ID=${shellQuote(launch.sessionId)} ORCHARD_WORKSPACE_PATH=${shellQuote(launch.worktreePath)} ORCHARD_ROOT_PATH=${shellQuote(launch.repoPath)}`,
    `printf 'running\\n' > ${shellQuote(status)}`,
    `printf '\\033[2m$ %s script from ${GREENHOUSE_CONFIG_PATH}\\033[0m\\n' ${shellQuote(launch.name)}`,
    `bash -l ${shellQuote(userPath)}`,
    'code=$?',
    `if [ "$code" -eq 0 ]; then printf 'done\\n' > ${shellQuote(status)}; else printf 'failed %s\\n' "$code" > ${shellQuote(status)}; fi`,
    `printf '\\n\\033[2m[%s exited with code %s]\\033[0m\\n' ${shellQuote(launch.name)} "$code"`,
    'exit "$code"'
  ];
  return { wrapperPath, userPath, wrapper: `${lines.join('\n')}\n` };
}

export function buildScriptLaunch(launch: ScriptLaunch): string {
  const dir = sessionStateDir(launch.sessionId);
  const name = tmuxSessionName(launch.sessionId, launch.name);
  const wrapper = `${dir}/${launch.name}.sh`;
  const log = `${dir}/${launch.name}.log`;
  const channel = `${name}-go`;
  return [
    `: > ${shellQuote(log)}`,
    `if ! command -v tmux >/dev/null 2>&1; then nohup bash ${shellQuote(wrapper)} >> ${shellQuote(log)} 2>&1 < /dev/null & exit 0; fi`,
    `tmux kill-session -t ${shellQuote(`=${name}`)} 2>/dev/null`,
    `tmux new-session -d -s ${shellQuote(name)} -n ${shellQuote(launch.name)} -c ${shellQuote(launch.worktreePath)} ${shellQuote(`bash ${shellQuote(wrapper)}`)} || exit 1`,
    `tmux set-option -w -t ${shellQuote(`=${name}:${launch.name}`)} remain-on-exit on >/dev/null 2>&1`,
    `tmux pipe-pane -t ${shellQuote(`=${name}:${launch.name}`)} ${shellQuote(`cat >> ${shellQuote(log)}`)} >/dev/null 2>&1`,
    `tmux wait-for -S ${shellQuote(channel)}`
  ].join('\n');
}

export function buildScriptStop(sessionId: string, name: 'setup' | 'run'): string {
  return `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${shellQuote(`=${tmuxSessionName(sessionId, name)}`)} 2>/dev/null; true`;
}

export interface ScriptsProbe {
  configText: string | null;
  setupStatus: string | null;
  runPaneDead: string | null;
}

export function buildScriptsProbe(
  sessionId: string,
  worktreePath: string,
  repoPath: string,
  nonce: string
): string {
  const dir = sessionStateDir(sessionId);
  const runName = tmuxSessionName(sessionId, 'run');
  return [
    `cfg=${shellQuote(`${worktreePath}/${GREENHOUSE_CONFIG_PATH}`)}`,
    `[ -f "$cfg" ] || cfg=${shellQuote(`${repoPath}/${GREENHOUSE_CONFIG_PATH}`)}`,
    `printf '@@${nonce}:config@@\\n'`,
    `[ -f "$cfg" ] && head -c ${MAX_GREENHOUSE_CONFIG_BYTES} -- "$cfg"`,
    `printf '\\n@@${nonce}:setup@@\\n'`,
    `cat ${shellQuote(`${dir}/setup.status`)} 2>/dev/null`,
    `printf '\\n@@${nonce}:run@@\\n'`,
    `command -v tmux >/dev/null 2>&1 && tmux list-panes -t ${shellQuote(`=${runName}`)} -F '#{pane_dead}' 2>/dev/null | head -n 1`,
    'true'
  ].join('\n');
}

export function parseScriptsProbe(stdout: string, nonce: string): ScriptsProbe {
  const configAt = stdout.indexOf(`@@${nonce}:config@@\n`);
  const setupAt = stdout.indexOf(`\n@@${nonce}:setup@@\n`);
  const runAt = stdout.indexOf(`\n@@${nonce}:run@@\n`);
  if (configAt < 0 || setupAt < 0 || runAt < 0) {
    return { configText: null, setupStatus: null, runPaneDead: null };
  }
  const configText = stdout.slice(configAt + `@@${nonce}:config@@\n`.length, setupAt);
  const setupStatus = stdout.slice(setupAt + `\n@@${nonce}:setup@@\n`.length, runAt).trim();
  const runPaneDead = stdout.slice(runAt + `\n@@${nonce}:run@@\n`.length).trim();
  return {
    configText: configText.trim() ? configText : null,
    setupStatus: setupStatus || null,
    runPaneDead: runPaneDead || null
  };
}

export type SetupState = 'none' | 'running' | 'done' | 'failed';

export function setupStateOf(status: string | null): SetupState {
  if (!status) return 'none';
  const word = status.split(/\s+/)[0];
  if (word === 'running' || word === 'done' || word === 'failed') return word;
  return 'none';
}

export interface SessionTerminalTarget {
  sessionId: string | null;
  index: string;
  mode: 'rw' | 'ro';
  worktreePath: string | null;
  terminalUserId?: string | null;
}

export interface TerminalShellEnv {
  envFile: string;
  tmuxEnv: string;
}

export function isScriptedTerminal(target: { sessionId: string | null; index: string }): boolean {
  return !!target.sessionId && (target.index === 'setup' || target.index === 'run');
}

export function terminalTmuxName(target: SessionTerminalTarget, engineSessionId: string): string {
  if (!target.sessionId) return `orchard-${engineSessionId.toLowerCase()}`;
  const base = tmuxSessionName(target.sessionId, target.index);
  if (isScriptedTerminal(target) || !target.terminalUserId) return base;
  if (!isUuid(target.terminalUserId)) throw new Error('invalid terminal owner');
  return `${base}-u${target.terminalUserId.replace(/-/g, '').toLowerCase()}`;
}

export const TMUX_TERMINAL =
  "tmux -u set-option -gq mouse off \\; set-option -sq 'terminal-overrides[90]' 'xterm*:smcup@:rmcup@' \\;";

const WAIT_FOR_DEV =
  'n=0; while ! id dev >/dev/null 2>&1 && [ $n -lt 300 ]; do sleep 1; n=$((n+1)); done; ' +
  'if ! id dev >/dev/null 2>&1; then echo "The sandbox is still setting up. Try again in a moment."; exit 1; fi; ' +
  'printf "\\033[2J\\033[H"; ';

export function sandboxTerminalCommand(
  target: SessionTerminalTarget,
  engineSessionId: string,
  shellEnv: TerminalShellEnv | null = null
): string[] {
  const dir =
    target.worktreePath && isWorktreePath(target.worktreePath) ? target.worktreePath : HOME_ROOT;
  const name = terminalTmuxName(target, engineSessionId);
  const env = 'export TERM=xterm-256color COLORTERM=truecolor; ';
  const exact = shellQuote(`=${name}`);
  const scripted = isScriptedTerminal(target);
  const prelude = `${env}cd ${shellQuote(dir)} 2>/dev/null || cd; `;
  let inner: string;
  if (target.mode === 'ro' || scripted) {
    const attach = `exec ${TMUX_TERMINAL} attach-session${target.mode === 'ro' ? ' -r' : ''} -t ${exact}`;
    const log =
      scripted && target.sessionId
        ? `${sessionStateDir(target.sessionId)}/${target.index}.log`
        : null;
    const fallback = log
      ? `[ -f ${shellQuote(log)} ] && exec tail -n +1 -f ${shellQuote(log)}; `
      : '';
    inner =
      prelude +
      `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${exact} 2>/dev/null && ${attach}; fi; ` +
      fallback +
      `command -v tmux >/dev/null 2>&1 || { printf 'tmux is not installed in this sandbox.\\r\\n'; exit 1; }; ` +
      `printf '\\033[2mWaiting for this terminal to start...\\033[0m\\r\\n'; ` +
      `while ! tmux has-session -t ${exact} 2>/dev/null; do sleep 2; done; ` +
      attach;
  } else if (shellEnv) {
    const file = shellQuote(shellEnv.envFile);
    const load = `[ -r ${file} ] && . ${file}; rm -f ${file}; `;
    const pane = `${load}${shellEnv.tmuxEnv ? `${shellEnv.tmuxEnv}; ` : ''}exec bash -l`;
    inner =
      prelude +
      'if command -v tmux >/dev/null 2>&1; then ' +
      `if tmux has-session -t ${exact} 2>/dev/null; then rm -f ${file}; exec ${TMUX_TERMINAL} attach-session -t ${exact}; fi; ` +
      `nohup sh -c ${shellQuote(`sleep 30; rm -f ${file}`)} >/dev/null 2>&1 & ` +
      `exec ${TMUX_TERMINAL} new-session -A -s ${shellQuote(name)} -c ${shellQuote(dir)} ${shellQuote(pane)}; ` +
      'fi; ' +
      load +
      'exec bash -l';
  } else {
    inner =
      prelude +
      `if command -v tmux >/dev/null 2>&1; then exec ${TMUX_TERMINAL} new-session -A -s ${shellQuote(name)} -c ${shellQuote(dir)}; fi; ` +
      'exec bash -l';
  }
  return ['/bin/sh', '-c', `${WAIT_FOR_DEV}exec su -l dev -c ${shellQuote(inner)}`];
}
