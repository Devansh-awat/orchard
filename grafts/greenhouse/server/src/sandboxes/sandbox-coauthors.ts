import { isUuid, isWorktreePath, sessionStateDir, shellQuote } from './sandbox-session-commands';

export const COAUTHOR_HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'pre-auto-gc'
] as const;

export const COAUTHOR_HOOK_SCRIPT = `#!/bin/sh
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
orig=
[ -n "$common" ] && orig=$(git config --file "$common/config" --get core.hooksPath 2>/dev/null)
[ -n "$orig" ] || orig=$(git config --global --get core.hooksPath 2>/dev/null)
[ -n "$orig" ] || orig="$common/hooks"
case "$orig" in
  /*) ;;
  "~/"*) orig="$HOME/\${orig#"~/"}" ;;
  *) orig="$(git rev-parse --show-toplevel 2>/dev/null)/$orig" ;;
esac
orig=$(cd "$orig" 2>/dev/null && pwd -P)
if [ -n "$orig" ] && [ "$orig" != "$here" ] && [ -f "$orig/$name" ] && [ -x "$orig/$name" ]; then
  "$orig/$name" "$@" || exit $?
fi
[ "$name" = prepare-commit-msg ] || exit 0
[ -n "$1" ] && [ -f "$1" ] || exit 0
[ "$2" = merge ] && exit 0
list="$here/../coauthors"
[ -s "$list" ] || exit 0
me=$(git var GIT_AUTHOR_IDENT 2>/dev/null | sed -n 's/^.*<\\([^>]*\\)>.*$/\\1/p')
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in *"<"*"@"*">") ;; *) continue ;; esac
  [ -n "$me" ] && case "$line" in *"<$me>") continue ;; esac
  who=\${line%% <*}
  grep -qiF "Co-authored-by: $who <" "$1" && continue
  git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Co-authored-by: $line" "$1" 2>/dev/null || true
done < "$list"
exit 0
`;

export function coauthorHookDir(sessionId: string): string {
  return `${sessionStateDir(sessionId)}/hooks`;
}

export function coauthorListPath(sessionId: string): string {
  return `${sessionStateDir(sessionId)}/coauthors`;
}

export function buildCoauthorHookInstall(sessionId: string, worktreePath: string): string {
  if (!isUuid(sessionId)) throw new Error('invalid session');
  if (!isWorktreePath(worktreePath)) throw new Error('invalid worktree');
  const dir = coauthorHookDir(sessionId);
  const hook = `${dir}/orchard-hook`;
  const wt = shellQuote(worktreePath);
  return [
    `mkdir -p ${shellQuote(dir)} || exit 1`,
    `cat > ${shellQuote(`${hook}.tmp`)} || exit 1`,
    `chmod 755 ${shellQuote(`${hook}.tmp`)} && mv -f ${shellQuote(`${hook}.tmp`)} ${shellQuote(hook)} || exit 1`,
    `for n in ${COAUTHOR_HOOK_NAMES.join(' ')}; do ln -sfn orchard-hook ${shellQuote(dir)}/"$n"; done`,
    `touch ${shellQuote(coauthorListPath(sessionId))}`,
    `git -C ${wt} config extensions.worktreeConfig true || exit 2`,
    `git -C ${wt} config --worktree core.hooksPath ${shellQuote(dir)} || exit 2`
  ].join('\n');
}

const HOOK_HEREDOC = 'ORCHARD_COAUTHOR_HOOK_EOF';

export function buildCoauthorHookInlineInstall(sessionId: string, worktreePath: string): string {
  if (COAUTHOR_HOOK_SCRIPT.split('\n').includes(HOOK_HEREDOC)) throw new Error('bad heredoc');
  const install = buildCoauthorHookInstall(sessionId, worktreePath).replace(
    /^(cat > \S+) \|\| exit 1$/m,
    (_, cat: string) =>
      `${cat} <<'${HOOK_HEREDOC}' || exit 1\n${COAUTHOR_HOOK_SCRIPT.replace(/\n$/, '')}\n${HOOK_HEREDOC}`
  );
  return `if (\n${install}\n) >&2; then echo '@@hook@@ok'; else echo '@@hook@@fail'; fi`;
}

export function coauthorLine(identity: { name: string; email: string }): string | null {
  const name = identity.name.replace(/\s+/g, ' ').trim();
  const email = identity.email.trim();
  if (!name || name.length > 200 || /[<>\r\n\0]/.test(name)) return null;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email) || email.length > 320) return null;
  return `${name} <${email}>`;
}

export type CoauthorUpdate = 'reset' | 'append';

export function buildCoauthorUpdate(sessionId: string, mode: CoauthorUpdate): string {
  if (!isUuid(sessionId)) throw new Error('invalid session');
  const file = shellQuote(coauthorListPath(sessionId));
  const dir = shellQuote(sessionStateDir(sessionId));
  const read = 'line=; IFS= read -r line';
  if (mode === 'reset') {
    return [
      `mkdir -p ${dir} || exit 1`,
      read,
      `if [ -n "$line" ]; then printf '%s\\n' "$line" > ${file}; else : > ${file}; fi`
    ].join('\n');
  }
  return [
    `mkdir -p ${dir} || exit 1`,
    read,
    '[ -n "$line" ] || exit 0',
    `grep -qxF -- "$line" ${file} 2>/dev/null || printf '%s\\n' "$line" >> ${file}`
  ].join('\n');
}
