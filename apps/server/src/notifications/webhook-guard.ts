import { BadRequestException } from '@nestjs/common';
import { lookup as dnsLookup } from 'dns';
import { Agent, fetch as pinnedFetch } from 'undici';
import { lookup as dnsLookupAsync } from 'dns/promises';
import { isIP } from 'net';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

export const BLOCKED_HOST_SUFFIXES = [
  '.svc',
  '.cluster.local',
  '.internal',
  '.local',
  '.localhost',
  '.consul'
];

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export class BlockedDestinationError extends BadRequestException {}

export function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

export function parseHttpUrl(raw: string | URL, label = 'URL'): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  } catch {
    throw new BadRequestException(`${label} isn't a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException(`${label} must use http or https`);
  }
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  if (port !== 80 && port !== 443 && port < 1024) {
    throw new BadRequestException(`${label} port must be 80, 443, or 1024+`);
  }
  return url;
}

export async function assertPublicUrl(raw: string | URL, label = 'URL'): Promise<URL> {
  const url = parseHttpUrl(raw, label);
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new BlockedDestinationError(`${label} must resolve to a public address`);
    }
    return url;
  }
  if (!host.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedDestinationError(`${label} must be a public hostname`);
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookupAsync(host, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException(`Could not resolve the ${label.toLowerCase()} host "${host}"`);
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedDestinationError(`${label} must resolve to a public address`);
  }
  return url;
}

export interface ResolvedHost {
  hostname: string;
  address: string;
  family: 4 | 6;
}

export async function resolvePublicHost(raw: string, label = 'Host'): Promise<ResolvedHost> {
  const hostname = raw
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  if (literal) {
    if (!isPublicAddress(hostname)) {
      throw new BlockedDestinationError(`${label} must resolve to a public address`);
    }
    return { hostname, address: hostname, family: literal as 4 | 6 };
  }
  if (!hostname.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new BlockedDestinationError(`${label} must be a public hostname`);
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookupAsync(hostname, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException(
      `Could not resolve the ${label.toLowerCase()} host "${hostname}"`
    );
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedDestinationError(`${label} must resolve to a public address`);
  }
  return { hostname, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}

let guardedHttp: HttpAgent | null = null;
let guardedHttps: HttpsAgent | null = null;

export function guardedAgents(): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  guardedHttp ??= new HttpAgent({ keepAlive: true, lookup: guardedLookup } as any);
  guardedHttps ??= new HttpsAgent({ keepAlive: true, lookup: guardedLookup } as any);
  return { httpAgent: guardedHttp, httpsAgent: guardedHttps };
}

export async function guardedS3Options(
  endpoint: string,
  label = 'Backup endpoint'
): Promise<{ requestHandler: { httpAgent: HttpAgent; httpsAgent: HttpsAgent } }> {
  await assertPublicUrl(endpoint, label);
  return { requestHandler: guardedAgents() };
}

export function assertSafeWebhookUrl(raw: string): Promise<URL> {
  return assertPublicUrl(raw, 'Webhook URL');
}

export interface GuardedFetchInit extends RequestInit {
  maxRedirects?: number;
  allowPrivate?: boolean;
  label?: string;
  /**
   * Cap on the final response body. A declared content-length over the cap is
   * refused before reading; a body that streams past it is aborted mid-read.
   */
  maxBodyBytes?: number;
}

export class ResponseTooLargeError extends Error {
  constructor(label: string, maxBytes: number) {
    super(`${label} response exceeds ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Wrap a response so reading more than `maxBytes` of its body errors and cancels the socket. */
export function capResponseBody(res: Response, maxBytes: number, label = 'URL'): Response {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(label, maxBytes);
  }
  if (!res.body) return res;
  let seen = 0;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(new ResponseTooLargeError(label, maxBytes));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const nativeFetch = globalThis.fetch;
let pinnedAgent: Agent | null = null;

function pinned(): Agent {
  pinnedAgent ??= new Agent({ connect: { lookup: guardedLookup } });
  return pinnedAgent;
}

export async function guardedFetch(
  input: string | URL,
  init: GuardedFetchInit = {}
): Promise<Response> {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowPrivate = false,
    label = 'URL',
    redirect,
    signal,
    maxBodyBytes,
    ...rest
  } = init;
  const check = (target: string | URL) =>
    allowPrivate ? Promise.resolve(parseHttpUrl(target, label)) : assertPublicUrl(target, label);
  let url = await check(input);
  let method = (rest.method ?? 'GET').toUpperCase();
  let body = rest.body;
  const headers = new Headers(rest.headers);
  const timeout = signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const res =
      allowPrivate || globalThis.fetch !== nativeFetch
        ? await fetch(url, { ...rest, method, body, headers, redirect: 'manual', signal: timeout })
        : ((await pinnedFetch(url, {
            ...(rest as any),
            method,
            body: body as any,
            headers,
            redirect: 'manual',
            signal: timeout,
            dispatcher: pinned()
          })) as unknown as Response);
    if (redirect === 'manual' || !isRedirect(res.status)) {
      return maxBodyBytes ? capResponseBody(res, maxBodyBytes, label) : res;
    }
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location) throw new BadRequestException(`${label} redirected without a location`);
    if (hop >= maxRedirects) throw new BadRequestException(`${label} redirected too many times`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new BadRequestException(`${label} redirected to an invalid URL`);
    }
    if (url.protocol === 'https:' && next.protocol !== 'https:') {
      throw new BlockedDestinationError(`${label} redirected off https`);
    }
    if (next.origin !== url.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    url = await check(next);
  }
}

// Re-checked at connect time, not just at save time: DNS can be re-pointed at a
// private address between the two.
export function guardedLookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      callback(
        Object.assign(new Error('Destination resolves to a non-public address'), {
          code: 'EBLOCKED'
        })
      );
      return;
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return false;
  const [g0, g1] = groups;

  const embedded = extractEmbeddedIpv4(groups);
  if (embedded) return isPublicIpv4(embedded);

  const allZero = groups.every((g) => g === 0);
  if (allZero) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false;
  if ((g0 & 0xfe00) === 0xfc00) return false;
  if ((g0 & 0xffc0) === 0xfe80) return false;
  if ((g0 & 0xffc0) === 0xfec0) return false;
  if ((g0 & 0xff00) === 0xff00) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2001 && g1 === 0x0000) return false;
  if (g0 === 0x2002) return false;
  return true;
}

function extractEmbeddedIpv4(groups: number[]): string | null {
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return toV4(groups[6], groups[7]);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return toV4(groups[6], groups[7]);
  }
  return null;
}

function expandIpv6(ip: string): number[] | null {
  const stripped = ip.replace(/%.+$/, '');
  let head = stripped;
  let tail = '';
  const dc = stripped.indexOf('::');
  if (dc >= 0) {
    head = stripped.slice(0, dc);
    tail = stripped.slice(dc + 2);
  }
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        const v4 = part.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        const n = parseInt(part, 16);
        if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };
  const headGroups = parse(head);
  const tailGroups = parse(tail);
  if (!headGroups || !tailGroups) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (dc < 0 && headGroups.length !== 8) return null;
  if (dc >= 0 && missing < 0) return null;
  return [...headGroups, ...(dc >= 0 ? Array(missing).fill(0) : []), ...tailGroups];
}
