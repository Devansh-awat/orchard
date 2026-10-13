const HOME_ROOT = '/persist/home';

export function inWorktree(
  directory: string | null | undefined,
  worktreePath: string | null | undefined
): boolean {
  if (!directory || !worktreePath) return false;
  if (directory === worktreePath) return true;
  if (!worktreePath.startsWith(`${HOME_ROOT}/`) || !directory.startsWith('/')) return false;
  return directory.endsWith(worktreePath.slice(HOME_ROOT.length));
}
