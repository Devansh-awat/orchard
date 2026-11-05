const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function sameOwnerRepo(raw: string, owner: string, repo: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  let parsed: URL;
  try {
    parsed = new URL(value, `https://github.com/${owner}/${repo}/`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0].toLowerCase() !== owner.toLowerCase()) return null;
  const name = parts[1].replace(/\.git$/i, '');
  return REPO_NAME.test(name) && !/^\.+$/.test(name) ? name : null;
}

export function submoduleRepos(gitmodules: string, owner: string, repo: string): string[] {
  const names = new Set<string>();
  for (const line of gitmodules.split(/\r?\n/)) {
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/i)?.[1];
    if (!url) continue;
    const name = sameOwnerRepo(url, owner, repo);
    if (name) names.add(name);
  }
  return [...names];
}
