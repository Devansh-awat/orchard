import type { Request } from 'express';
import type { IncomingMessage } from 'http';

type Headers = IncomingMessage['headers'];

// Canonical client-IP extraction.
//
// Only hop counting has a trust model: a header is worth something if our own
// proxy wrote it, and the only way to know that is its position relative to the
// socket. So X-Forwarded-For plus TRUST_PROXY is the primary source, read from
// the right exactly as Express's `trust proxy` does -- with n trusted hops the
// client is at index (length - n), not (length - 1 - n).
//
// X-Real-IP is kept ahead of it because Traefik overwrites it for sources
// outside its trustedIPs. CLIENT_IP_HEADER opts into one more, for operators
// running behind a CDN that overwrites its own (Cloudflare's CF-Connecting-IP).
// Both are forgeable by anyone who can reach the origin directly, so
// CLIENT_IP_HEADER is off unless the origin only accepts that CDN's traffic.

function trustedHops(): number {
  const raw = process.env.TRUST_PROXY ?? '1';
  if (raw === '0' || raw.toLowerCase() === 'false') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 1;
}

function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== 'string') return null;
  const trimmed = single.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fromOverwrittenHeaders(headers: Headers): string | null {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configured) {
    const value = header(headers, configured);
    if (value) return value;
  }
  return header(headers, 'x-real-ip');
}

function fromForwardedFor(headers: Headers): string | null {
  const hops = trustedHops();
  if (hops === 0) return null;

  const raw = headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (!joined) return null;

  const list = joined
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) return null;

  return list[Math.max(0, list.length - hops)] ?? null;
}

export function getClientIp(req: Request): string {
  return (
    fromOverwrittenHeaders(req.headers) ??
    fromForwardedFor(req.headers) ??
    req.ip ??
    req.socket?.remoteAddress ??
    'unknown'
  );
}

// The WebSocket upgrade path only ever sees a raw IncomingMessage, so it cannot
// lean on Express's req.ip and has to do the same hop arithmetic itself. Before
// this existed it fell through to the socket peer, which is our own proxy, so
// every client on an ingress shared one throttle bucket.
export function getRawClientIp(req: IncomingMessage): string {
  return (
    fromOverwrittenHeaders(req.headers) ??
    fromForwardedFor(req.headers) ??
    req.socket?.remoteAddress ??
    'unknown'
  );
}
