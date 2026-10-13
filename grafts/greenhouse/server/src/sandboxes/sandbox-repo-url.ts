import { BadRequestException } from '@nestjs/common';

export function withoutRepoCredentials(value: string | null): string | null {
  if (!value) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!parsed.username && !parsed.password) return value;
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

export function parseRepoUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('repoUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('repoUrl must be an https URL');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException(
      'repoUrl must not contain credentials; Orchard authenticates with your linked GitHub account'
    );
  }
  return parsed;
}

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_REMOTE_RES = [
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
];

export function githubRepoOf(
  remote: string | null | undefined
): { owner: string; name: string } | null {
  if (typeof remote !== 'string') return null;
  const value = remote.trim();
  for (const re of GITHUB_REMOTE_RES) {
    const m = value.match(re);
    if (!m) continue;
    if (!GITHUB_OWNER_RE.test(m[1]) || !GITHUB_NAME_RE.test(m[2]) || /^\.+$/.test(m[2])) {
      return null;
    }
    return { owner: m[1], name: m[2] };
  }
  return null;
}

export function cloneErrorMessage(
  output: string,
  repo: { label: string; github: boolean; withToken: boolean }
): string {
  const text = output.toLowerCase();
  const denied =
    text.includes('not found') ||
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('invalid username or token') ||
    text.includes('permission denied') ||
    text.includes('403');
  if (denied && repo.github && !repo.withToken) {
    return `Link your GitHub account in Settings to clone ${repo.label}`;
  }
  if (denied) return `${repo.label} was not found, or your GitHub account cannot read it`;
  if (text.includes('could not resolve host') || text.includes('timed out')) {
    return `Could not reach ${repo.label} from this machine`;
  }
  return `Could not clone ${repo.label}`;
}
