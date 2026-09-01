const SHELL_SAFE_HTTPS_URL = /^https:\/\/[A-Za-z0-9._~:/@+%-]+$/;

export function parseRepoUrl(repoUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (!SHELL_SAFE_HTTPS_URL.test(url.href)) return null;
  return url;
}

export function withGitHubCredentials(repo: URL, accessToken?: string): string {
  if (!accessToken || repo.hostname !== 'github.com') return repo.href;
  const credentials = accessToken.startsWith('ghs_')
    ? `x-access-token:${accessToken}`
    : accessToken;
  return `https://${credentials}@github.com${repo.pathname}${repo.search}`;
}
