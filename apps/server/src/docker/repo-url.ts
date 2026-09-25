import { decodeCloneCredential } from '../git/clone-credential';

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

/**
 * Put a credential on a clone URL, and only on the host it belongs to. A
 * GitHub token (the App path) is pinned to github.com; a connection
 * credential carries its own host and is pinned to that. Anything else
 * clones anonymously rather than leaking a secret to a stranger.
 */
export function withCloneCredentials(repo: URL, accessToken?: string): string {
  if (!accessToken) return repo.href;
  const cred = decodeCloneCredential(accessToken);
  if (cred) {
    if (repo.host.toLowerCase() !== cred.host) return repo.href;
    const user = encodeURIComponent(cred.username);
    const pass = encodeURIComponent(cred.password);
    return `https://${user}:${pass}@${repo.host}${repo.pathname}${repo.search}`;
  }
  if (repo.hostname !== 'github.com') return repo.href;
  const credentials = accessToken.startsWith('ghs_')
    ? `x-access-token:${accessToken}`
    : accessToken;
  return `https://${credentials}@github.com${repo.pathname}${repo.search}`;
}

export const withGitHubCredentials = withCloneCredentials;
