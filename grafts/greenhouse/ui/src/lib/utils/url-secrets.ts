export type UrlSecretKind = 'share:sandbox' | 'link:slack';

const PREFIX = 'orchard:url-secret:';
const memory = new Map<UrlSecretKind, string>();

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function secretRoute(pathname: string): UrlSecretKind | null {
  if (pathname === '/share/sandbox' || pathname.startsWith('/share/sandbox/'))
    return 'share:sandbox';
  if (pathname === '/integrations/slack/link' || pathname.startsWith('/integrations/slack/link/'))
    return 'link:slack';
  return null;
}

export function rememberUrlSecret(kind: UrlSecretKind, value: string) {
  memory.set(kind, value);
  try {
    session()?.setItem(PREFIX + kind, value);
  } catch {
    return;
  }
}

export function urlSecret(kind: UrlSecretKind): string | null {
  try {
    const saved = session()?.getItem(PREFIX + kind) ?? null;
    if (saved) {
      memory.set(kind, saved);
      return saved;
    }
  } catch {
    return memory.get(kind) ?? null;
  }
  return memory.get(kind) ?? null;
}

export function forgetUrlSecret(kind: UrlSecretKind) {
  memory.delete(kind);
  try {
    session()?.removeItem(PREFIX + kind);
  } catch {
    return;
  }
}

export function captureUrlSecrets(): UrlSecretKind | null {
  if (typeof location === 'undefined' || typeof history === 'undefined') return null;
  const kind = secretRoute(location.pathname);
  if (!kind) return null;
  const url = new URL(location.href);
  const share = kind === 'share:sandbox';
  const value = decode(share ? url.hash.replace(/^#/, '') : (url.searchParams.get('token') ?? ''));
  if (!value) return kind;
  rememberUrlSecret(kind, value);
  if (share) url.hash = '';
  else url.searchParams.delete('token');
  history.replaceState(history.state, '', `${url.pathname}${url.search}`);
  return kind;
}
