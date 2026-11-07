export interface ImageRef {
  host: string | null;
  repository: string;
  tag: string | null;
  digest: string | null;
}

const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.?)(?::\d{1,5})?$/;
const REPO_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[\w][\w.-]{0,127}$/;
const DIGEST_RE = /^[a-z][a-z0-9]*(?:[+._-][a-z][a-z0-9]*)*:[0-9a-fA-F]{32,}$/;

export function parseImageRef(raw: string): ImageRef | null {
  if (typeof raw !== 'string') return null;
  let rest = raw.trim();
  if (!rest || rest.length > 1024 || /[\s\\\u0000-\u001f]/.test(rest)) return null;

  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }

  let host: string | null = null;
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    const head = rest.slice(0, slash);
    if (
      head.includes('.') ||
      head.includes(':') ||
      head === 'localhost' ||
      head !== head.toLowerCase()
    ) {
      host = head.toLowerCase();
      if (!HOST_RE.test(host)) return null;
      rest = rest.slice(slash + 1);
    }
  }

  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.indexOf(':', lastSlash + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG_RE.test(tag)) return null;
  }

  if (!rest || !rest.split('/').every((part) => REPO_COMPONENT_RE.test(part))) return null;
  return { host, repository: rest, tag, digest };
}

function normalizePort(port: string): string {
  const n = Number(port);
  return n === 80 || n === 443 ? '' : String(n);
}

export function canonicalRegistryHost(raw: string): string | null {
  const lowered = raw.trim().toLowerCase();
  if (!lowered || /[\s/\\@?#%]/.test(lowered)) return null;
  let url: URL;
  try {
    url = new URL(`http://${lowered}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const hostname = url.hostname.replace(/\.+$/, '');
  if (!hostname) return null;
  const port = url.port ? normalizePort(url.port) : '';
  return port ? `${hostname}:${port}` : hostname;
}

function ipv4Octets(hostname: string): number[] | null {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? m.slice(1).map(Number) : null;
}

export function isLoopbackHost(raw: string): boolean {
  const canonical = canonicalRegistryHost(raw);
  if (canonical === null) return true;
  const hostname = canonical.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const v4 = ipv4Octets(hostname);
  if (v4) return v4[0] === 127 || v4.every((o) => o === 0);
  if (!hostname.includes(':')) return false;
  if (hostname === '::1' || hostname === '::') return true;
  const mapped = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped)
    return parseInt(mapped[1], 16) >> 8 === 127 || (mapped[1] === '0' && mapped[2] === '0');
  return false;
}

export function sameRegistryHost(a: string, b: string): boolean {
  const left = canonicalRegistryHost(a);
  const right = canonicalRegistryHost(b);
  return left !== null && right !== null && left === right;
}

export function repositoryName(ref: ImageRef): string {
  return ref.repository.split('/').pop() ?? ref.repository;
}

export function imageRepoFilters(repo: string): { contains?: string; endsWith?: string }[] {
  return [{ contains: `/${repo}:` }, { contains: `/${repo}@` }, { endsWith: `/${repo}` }];
}
