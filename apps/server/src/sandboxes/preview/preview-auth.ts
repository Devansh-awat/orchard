import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

export const PREVIEW_PORTS: readonly number[] = [3000, 3001, 4173, 5173, 8000, 8080, 8787];
export const RESERVED_SANDBOX_PORTS: readonly number[] = [22, 2222, 4096];
export const MIN_DECLARED_PREVIEW_PORT = 1024;
export const MAX_DECLARED_PREVIEW_PORTS = 10;
export const PREVIEW_COOKIE = 'orchard_preview';
export const PREVIEW_EXCHANGE_PATH = '/__orchard_preview';
export const PREVIEW_TOKEN_TTL_MS = 60_000;
export const PREVIEW_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
export const previewTokenKey = (jti: string) => `sbx-preview-token:${jti}`;

const HOST_LABEL_RE = /^(\d{2,5})-([0-9a-f]{8})$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const STRIPPED_COOKIES = new Set([
  PREVIEW_COOKIE,
  'session_token',
  'github_oauth_state',
  'git_oauth_state'
]);
const STRIPPED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-orchard-exec-proxy',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export interface PreviewTokenPayload {
  jti: string;
  sid: string;
  uid: string;
  port: number;
  exp: number;
}

export interface PreviewCookiePayload {
  sid: string;
  uid: string;
  port: number;
  host: string;
  exp: number;
}

export interface PreviewHost {
  host: string;
  port: number;
  id8: string;
}

export interface PreviewTokenStore {
  put(key: string, value: string, ttlMs: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

export function previewKey(secret: string, purpose: 'token' | 'cookie'): Buffer {
  return createHmac('sha256', secret).update(`orchard-preview:${purpose}`).digest();
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

function encode(key: Buffer, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(key, body)}`;
}

function decode<T>(key: Buffer, value: string): T | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(key, body), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function normalizePreviewDomain(value: string | null | undefined): string | null {
  const domain = (value || '').trim().toLowerCase().replace(/\.$/, '');
  return domain && DOMAIN_RE.test(domain) ? domain : null;
}

export function previewHostFor(sandboxId: string, port: number, domain: string): string {
  return `${port}-${sandboxId.replace(/-/g, '').slice(0, 8).toLowerCase()}.${domain}`;
}

export function previewOriginFor(sandboxId: string, port: number, domain: string): string {
  return `https://${previewHostFor(sandboxId, port, domain)}`;
}

export function stripHostPort(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value;
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}

export function isUnderDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function parsePreviewHost(
  hostHeader: string | undefined,
  domain: string | null
): PreviewHost | null {
  if (!hostHeader || !domain) return null;
  const host = stripHostPort(hostHeader);
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, host.length - domain.length - 1);
  const match = label.match(HOST_LABEL_RE);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, id8: match[2] };
}

export function sandboxMatchesId8(sandboxId: string, id8: string): boolean {
  return sandboxId.replace(/-/g, '').slice(0, 8).toLowerCase() === id8;
}

export function isDeclarablePreviewPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= MIN_DECLARED_PREVIEW_PORT &&
    port <= 65535 &&
    !RESERVED_SANDBOX_PORTS.includes(port)
  );
}

export function isPreviewPortAllowed(port: number, extra: readonly number[] = []): boolean {
  if (PREVIEW_PORTS.includes(port)) return true;
  return isDeclarablePreviewPort(port) && extra.includes(port);
}

export function isPreviewPortCandidate(port: number): boolean {
  return PREVIEW_PORTS.includes(port) || isDeclarablePreviewPort(port);
}

export function declaredPreviewPorts(runnerState: unknown): number[] {
  const value =
    runnerState && typeof runnerState === 'object' && !Array.isArray(runnerState)
      ? (runnerState as Record<string, unknown>).declaredPorts
      : undefined;
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const port of value) {
    if (isDeclarablePreviewPort(port) && !out.includes(port)) out.push(port);
    if (out.length >= MAX_DECLARED_PREVIEW_PORTS) break;
  }
  return out;
}

export function mergeDeclaredPorts(
  existing: readonly number[],
  incoming: readonly number[]
): number[] {
  const out: number[] = [];
  for (const port of [...incoming, ...existing]) {
    if (!isDeclarablePreviewPort(port) || PREVIEW_PORTS.includes(port) || out.includes(port)) {
      continue;
    }
    out.push(port);
    if (out.length >= MAX_DECLARED_PREVIEW_PORTS) break;
  }
  return out;
}

export async function mintPreviewToken(
  store: PreviewTokenStore,
  secret: string,
  input: { sandboxId: string; userId: string; port: number },
  now: number = Date.now()
): Promise<string> {
  const payload: PreviewTokenPayload = {
    jti: randomUUID(),
    sid: input.sandboxId,
    uid: input.userId,
    port: input.port,
    exp: now + PREVIEW_TOKEN_TTL_MS
  };
  await store.put(previewTokenKey(payload.jti), '1', PREVIEW_TOKEN_TTL_MS + 5_000);
  return encode(previewKey(secret, 'token'), payload);
}

export async function redeemPreviewToken(
  store: PreviewTokenStore,
  secret: string,
  token: string,
  host: PreviewHost,
  now: number = Date.now()
): Promise<PreviewTokenPayload | null> {
  const payload = decode<PreviewTokenPayload>(previewKey(secret, 'token'), token);
  if (!payload || typeof payload.jti !== 'string' || typeof payload.sid !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (payload.port !== host.port || !sandboxMatchesId8(payload.sid, host.id8)) return null;
  const marker = await store.take(previewTokenKey(payload.jti));
  if (marker === null) return null;
  return payload;
}

export function signPreviewCookie(
  secret: string,
  input: { sandboxId: string; userId: string; port: number; host: string },
  now: number = Date.now()
): string {
  const payload: PreviewCookiePayload = {
    sid: input.sandboxId,
    uid: input.userId,
    port: input.port,
    host: input.host,
    exp: now + PREVIEW_COOKIE_TTL_MS
  };
  return encode(previewKey(secret, 'cookie'), payload);
}

export function verifyPreviewCookie(
  secret: string,
  value: string,
  host: PreviewHost,
  now: number = Date.now()
): PreviewCookiePayload | null {
  const payload = decode<PreviewCookiePayload>(previewKey(secret, 'cookie'), value);
  if (!payload || typeof payload.sid !== 'string' || typeof payload.uid !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (payload.host !== host.host || payload.port !== host.port) return null;
  if (!sandboxMatchesId8(payload.sid, host.id8)) return null;
  return payload;
}

export function previewCookieHeader(value: string): string {
  return `${PREVIEW_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(PREVIEW_COOKIE_TTL_MS / 1000)}`;
}

export function parseCookieHeader(header: string | string[] | undefined): Array<[string, string]> {
  const raw = Array.isArray(header) ? header.join('; ') : header || '';
  const out: Array<[string, string]> = [];
  for (const pair of raw.split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    if (!name) continue;
    out.push([name, pair.slice(at + 1).trim()]);
  }
  return out;
}

export function previewCookieValues(header: string | string[] | undefined): string[] {
  return parseCookieHeader(header)
    .filter(([name]) => name === PREVIEW_COOKIE)
    .map(([, value]) => value);
}

export function forwardableCookies(header: string | string[] | undefined): string | null {
  const kept = parseCookieHeader(header).filter(
    ([name]) => !STRIPPED_COOKIES.has(name) && !name.toLowerCase().startsWith('orchard')
  );
  return kept.length ? kept.map(([n, v]) => `${n}=${v}`).join('; ') : null;
}

export function previewUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  host: PreviewHost,
  clientIp: string | undefined
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const connectionTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    if (lower.startsWith('x-orchard-')) continue;
    out[lower] = value;
  }
  const cookies = forwardableCookies(headers.cookie);
  if (cookies) out.cookie = cookies;
  out.host = `localhost:${host.port}`;
  out['x-forwarded-host'] = host.host;
  out['x-forwarded-proto'] = 'https';
  if (clientIp) out['x-forwarded-for'] = clientIp;
  return out;
}

export function rewriteSetCookie(value: string): string | null {
  const parts = value.split(';');
  const first = parts[0] ?? '';
  const name = first.slice(0, Math.max(0, first.indexOf('='))).trim();
  if (!name || STRIPPED_COOKIES.has(name) || name.toLowerCase().startsWith('orchard')) return null;
  return parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p)).join(';');
}

export function previewDownstreamHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection'].includes(lower))
      continue;
    if (lower === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [value])
        .map(rewriteSetCookie)
        .filter((v): v is string => v !== null);
      if (list.length) out[lower] = list;
      continue;
    }
    out[lower] = value;
  }
  return out;
}

export function previewRequestAllowed(
  headers: Record<string, string | string[] | undefined>,
  host: PreviewHost,
  domain: string,
  method: string
): boolean {
  const sameSandbox = (value: string): boolean => {
    try {
      const parsed = parsePreviewHost(new URL(value).host, domain);
      return !!parsed && parsed.id8 === host.id8;
    } catch {
      return false;
    }
  };
  const origin = typeof headers.origin === 'string' ? headers.origin : null;
  if (origin !== null) {
    if (origin === 'null') return false;
    return sameSandbox(origin);
  }
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : null;
  if (!site || site === 'same-origin' || site === 'none') return true;
  const mode = headers['sec-fetch-mode'];
  const dest = headers['sec-fetch-dest'];
  const safeMethod = method === 'GET' || method === 'HEAD';
  if (safeMethod && mode === 'navigate' && (!dest || dest === 'document')) return true;
  if (site === 'same-site') {
    const referer = typeof headers.referer === 'string' ? headers.referer : null;
    return !!referer && sameSandbox(referer);
  }
  return false;
}

export function previewDomainConflict(
  previewDomain: string,
  env: {
    cookieDomain?: string | null;
    frontendUrl?: string | null;
    platformOrigins?: string | null;
    apiUrl?: string | null;
  }
): string | null {
  const preview = normalizePreviewDomain(previewDomain);
  if (!preview) return 'previewDomain must be a bare domain name such as preview.example.com';
  const protectedHosts: Array<{ host: string; label: string }> = [];
  const cookie = (env.cookieDomain || '').trim().toLowerCase().replace(/^\./, '');
  if (cookie) protectedHosts.push({ host: cookie, label: 'the Orchard session cookie domain' });
  const urls = [
    env.frontendUrl,
    env.apiUrl,
    ...(env.platformOrigins || '').split(',').map((s) => s.trim())
  ];
  for (const url of urls) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host) protectedHosts.push({ host, label: `the Orchard host ${host}` });
    } catch {}
  }
  for (const { host, label } of protectedHosts) {
    if (preview === host) return `previewDomain must not be ${label}`;
    if (isUnderDomain(preview, host)) {
      return `previewDomain must not be under ${label}; previews run untrusted code and could set cookies for it`;
    }
    if (isUnderDomain(host, preview)) {
      return `previewDomain must not be a parent of ${label}; previews could read or set its cookies`;
    }
  }
  return null;
}
