import type { Request } from 'express';
import type { IncomingMessage } from 'http';
import ipaddr from 'ipaddr.js';

type Headers = IncomingMessage['headers'];

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

const INFRASTRUCTURE_RANGES = new Set([
  'unspecified',
  'loopback',
  'private',
  'linkLocal',
  'uniqueLocal',
  'carrierGradeNat'
]);

const MAX_FORWARDED_ENTRIES = 50;

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseCidrs(values: string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const value of values) {
    try {
      out.push(ipaddr.parseCIDR(value.trim()) as Cidr);
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

function parse(value: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const bare = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split('%')[0];
  try {
    return ipaddr.process(bare);
  } catch {
    return null;
  }
}

function inRanges(addr: ipaddr.IPv4 | ipaddr.IPv6, ranges: Cidr[]): boolean {
  for (const [net, bits] of ranges) {
    if (addr.kind() !== net.kind()) continue;
    if (addr.kind() === 'ipv4') {
      if ((addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits)) return true;
    } else if ((addr as ipaddr.IPv6).match(net as ipaddr.IPv6, bits)) return true;
  }
  return false;
}

function isInfrastructure(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (INFRASTRUCTURE_RANGES.has(addr.range())) return true;
  return inRanges(addr, extraRanges());
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

function explicitHops(): number | null {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined) return null;
  if (raw === '0' || raw.toLowerCase() === 'false') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return null;
}

function chain(headers: Headers, socketAddress: string | undefined): string[] {
  const out: string[] = [];
  if (socketAddress) out.push(socketAddress);
  const xff = forwardedFor(headers);
  for (let i = xff.length - 1; i >= 0; i--) out.push(xff[i]);
  return out;
}

function resolve(headers: Headers, socketAddress: string | undefined): string | null {
  const hops = explicitHops();

  if (hops !== null) {
    if (hops === 0) return socketAddress ?? null;
    const xff = forwardedFor(headers);
    if (xff.length === 0) return socketAddress ?? null;
    return xff[Math.max(0, xff.length - hops)] ?? null;
  }

  const walk = chain(headers, socketAddress);
  let sawCloudflare = false;

  for (const candidate of walk) {
    const addr = parse(candidate);
    if (!addr) continue;
    if (isInfrastructure(addr)) continue;
    if (trustCloudflare() && inRanges(addr, cloudflare)) {
      sawCloudflare = true;
      continue;
    }
    return candidate;
  }

  if (sawCloudflare) {
    const connecting = header(headers, 'cf-connecting-ip');
    if (connecting) return connecting;
  }

  return header(headers, 'x-real-ip') ?? walk[walk.length - 1] ?? null;
}

export function getClientIp(req: Request): string {
  return resolve(req.headers, req.socket?.remoteAddress) ?? req.ip ?? 'unknown';
}

export function getRawClientIp(req: IncomingMessage): string {
  return resolve(req.headers, req.socket?.remoteAddress) ?? 'unknown';
}
