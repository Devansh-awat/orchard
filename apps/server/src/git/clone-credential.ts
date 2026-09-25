import type { CloneCredential } from './git-provider';

const PREFIX = 'git-cred:';

/**
 * A clone credential travels through the build pipeline as one opaque
 * string so the GitHub path and the provider path share a channel. The host
 * rides along with it and `withCloneCredentials` refuses to send it anywhere
 * else, which is the same pinning rule the GitHub token always had.
 */
export function encodeCloneCredential(cred: CloneCredential): string {
  const pair = Buffer.from(`${cred.username}:${cred.password}`).toString('base64');
  return `${PREFIX}${cred.host.toLowerCase()}:${pair}`;
}

export function decodeCloneCredential(token: string | undefined | null): CloneCredential | null {
  if (!token || !token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const host = rest.slice(0, split);
  let pair: string;
  try {
    pair = Buffer.from(rest.slice(split + 1), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = pair.indexOf(':');
  if (colon < 0) return null;
  return { host, username: pair.slice(0, colon), password: pair.slice(colon + 1) };
}

/** Userinfo in any https URL, whatever the token looks like. */
export function redactUrlUserinfo(text: string): string {
  return text.replace(/(https?:\/\/)[^@/\s'"]+@/gi, '$1***@');
}
