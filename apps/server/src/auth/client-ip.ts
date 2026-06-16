import type { Request } from 'express';

// Canonical client-IP extraction. Prefer X-Real-IP because Traefik sets it
// to the socket peer of the inbound TCP connection and overwrites any
// client-supplied value for sources outside `forwardedHeaders.trustedIPs`,
// making it the only header we can naively trust. Fall back to Express's
// req.ip (which honors X-Forwarded-For when `trust proxy` is enabled in
// main.ts via the TRUST_PROXY env var) and finally to the raw socket peer.
export function getClientIp(req: Request): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
