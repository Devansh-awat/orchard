import type { Request } from 'express';
import type { IncomingMessage } from 'http';
import ipaddr from 'ipaddr.js';

type Headers = IncomingMessage['headers'];
type Addr = ipaddr.IPv4 | ipaddr.IPv6;
type Cidr = [Addr, number];

const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

const NON_PUBLIC_RANGES = new Set([
  'unspecified',
  'loopback',
  'private',
  'linkLocal',
  'uniqueLocal',
  'carrierGradeNat'
]);

const MAX_FORWARDED_ENTRIES = 50;

export interface ProxyTrust {
  hops: number;
  ranges: Cidr[];
}

function bareToCidr(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes('/') ? trimmed : `${trimmed}/${trimmed.includes(':') ? 128 : 32}`;
}

function parseCidrs(values: string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const value of values) {
    try {
      out.push(ipaddr.parseCIDR(bareToCidr(value)) as Cidr);
    } catch {}
  }
  return out;
}

const cloudflare = parseCidrs(CLOUDFLARE_RANGES);

let extraSource: string | undefined;
let extra: Cidr[] = [];

function extraRanges(): Cidr[] {
  const raw = process.env.TRUSTED_PROXY_RANGES;
  if (raw !== extraSource) {
    extraSource = raw;
    extra = raw ? parseCidrs(raw.split(',')) : [];
  }
  return extra;
}

export function parseTrustProxy(raw: string | undefined): ProxyTrust {
  if (raw === undefined || raw.trim() === '') return { hops: 0, ranges: [] };
  const value = raw.trim();
  if (value.toLowerCase() === 'false') return { hops: 0, ranges: [] };
  if (/^\d+$/.test(value)) {
    return { hops: Math.min(Number(value), MAX_FORWARDED_ENTRIES), ranges: [] };
  }
  return { hops: 0, ranges: parseCidrs(value.split(',')) };
}

let trustSource: string | undefined;
let trustParsed: ProxyTrust = { hops: 0, ranges: [] };

function trustConfig(): ProxyTrust {
  const raw = process.env.TRUST_PROXY;
  if (raw !== trustSource) {
    trustSource = raw;
    trustParsed = parseTrustProxy(raw);
  }
  return trustParsed;
}

export function trustProxySetting(): number | string[] | false {
  const raw = process.env.TRUST_PROXY;
  const { hops, ranges } = parseTrustProxy(raw);
  if (ranges.length > 0) {
    return (raw as string)
      .split(',')
      .map((part) => bareToCidr(part))
      .filter(Boolean);
  }
  return hops > 0 ? hops : false;
}

interface TrustedHeader {
  name: string;
  from: Cidr[];
}

let headerSource: string | undefined;
let headerParsed: TrustedHeader | null = null;

function trustedHeader(): TrustedHeader | null {
  const key = `${process.env.CLIENT_IP_HEADER}|${process.env.CLIENT_IP_HEADER_FROM}`;
  if (key !== headerSource) {
    headerSource = key;
    const name = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
    const from = process.env.CLIENT_IP_HEADER_FROM
      ? parseCidrs(process.env.CLIENT_IP_HEADER_FROM.split(','))
      : [];
    headerParsed = name && from.length > 0 ? { name, from } : null;
  }
  return headerParsed;
}

function parse(value: string): Addr | null {
  const bare = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split('%')[0];
  try {
    return ipaddr.process(bare);
  } catch {
    return null;
  }
}

function inRanges(addr: Addr, ranges: Cidr[]): boolean {
  for (const [net, bits] of ranges) {
    if (addr.kind() !== net.kind()) continue;
    if (addr.kind() === 'ipv4') {
      if ((addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits)) return true;
    } else if ((addr as ipaddr.IPv6).match(net as ipaddr.IPv6, bits)) return true;
  }
  return false;
}

function trustCloudflare(): boolean {
  return process.env.TRUST_CLOUDFLARE !== 'false';
}

function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== 'string') return null;
  const trimmed = single.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function forwardedFor(headers: Headers): string[] {
  const raw = headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (!joined) return [];
  return joined
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(-MAX_FORWARDED_ENTRIES);
}

function chain(headers: Headers, socketAddress: string | undefined): string[] {
  const out: string[] = [];
  if (socketAddress) out.push(socketAddress);
  const xff = forwardedFor(headers);
  for (let i = xff.length - 1; i >= 0; i--) out.push(xff[i]);
  return out;
}

function isTrustedHop(index: number, addr: Addr, trust: ProxyTrust): boolean {
  if (index < trust.hops) return true;
  if (trust.ranges.length > 0 && inRanges(addr, trust.ranges)) return true;
  if (inRanges(addr, extraRanges())) return true;
  return false;
}

function resolve(headers: Headers, socketAddress: string | undefined): string | null {
  const trust = trustConfig();
  const walk = chain(headers, socketAddress);
  if (walk.length === 0) return null;

  let sawCloudflare = false;
  let client: string | null = null;

  for (let i = 0; i < walk.length; i++) {
    const addr = parse(walk[i]);
    if (addr && isTrustedHop(i, addr, trust)) continue;
    if (addr && i > 0 && trustCloudflare() && inRanges(addr, cloudflare)) {
      sawCloudflare = true;
      continue;
    }
    client = walk[i];
    break;
  }

  if (client === null) {
    if (sawCloudflare) {
      const connecting = header(headers, 'cf-connecting-ip');
      if (connecting && parse(connecting)) return connecting;
    }
    return walk[walk.length - 1];
  }

  const override = trustedHeader();
  if (override) {
    const hop = parse(client);
    if (hop && inRanges(hop, override.from)) {
      const value = header(headers, override.name);
      if (value && parse(value)) return value;
    }
  }

  return client;
}

export function isCollapsedAddress(value: string): boolean {
  const bare = value.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/i, '');
  const addr = parse(bare);
  if (!addr) return true;
  return NON_PUBLIC_RANGES.has(addr.range());
}

export function getClientIp(req: Request): string {
  return resolve(req.headers, req.socket?.remoteAddress) ?? req.ip ?? 'unknown';
}

export function getRawClientIp(req: IncomingMessage): string {
  return resolve(req.headers, req.socket?.remoteAddress) ?? 'unknown';
}
