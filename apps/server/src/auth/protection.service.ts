import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { Duplex } from 'stream';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';
import { getClientIp, getRawClientIp } from './client-ip';
import { RedisThrottleService, type ThrottleWindow } from './redis-throttle.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { ingressPublicUrl } from '../projects/projects.utils';

export interface ProtectionDecision {
  allow: boolean;
  status?: number;
  headers?: Record<string, string>;
}

interface CachedIngress {
  id: string;
  projectId: string;
  protectionMode: string;
  protectionUsername: string | null;
  protectionPasswordHash: string | null;
  protectionBypassSecret: string | null;
  protectionBypassPaths: string[];
  redirectTarget: string | null;
  redirectStatus: number | null;
  project: { organizationId: string; name: string };
  host: string;
  tlsSecretName: string | null;
  entrypoints: string[];
  upstreamHost: string | null;
  upstreamPort: number | null;
  expiresAt: number;
}

// A path two parsers could resolve differently never gets the bypass: the
// proxy forwards the raw URL, so what matches here has to be what the app sees.
export function pathIsAmbiguous(originalUrl: string): boolean {
  const raw = (originalUrl || '/').split('?')[0];
  if (/[\\#]|%2e|%2f|%5c/i.test(raw)) return true;
  try {
    decodeURIComponent(raw);
    return false;
  } catch {
    return true;
  }
}

export function normalizeRequestPath(originalUrl: string): string {
  const withoutQuery = (originalUrl || '/').split('?')[0].split('#')[0];
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function redirectLocationFor(requestTarget: string, redirectTarget: string): string {
  const target = new URL(redirectTarget);
  const incoming = new URL(requestTarget || '/', 'http://orchard.invalid');
  const prefix = target.pathname.replace(/\/+$/, '');
  const location = new URL(target.origin);
  location.pathname = `${prefix}${incoming.pathname}`;
  location.search = incoming.search;
  return location.toString();
}

export function normalizeBypassPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  if (/\s/.test(value)) return null;
  if (value.length > 200) return null;
  value = value.replace(/\*+$/, '');
  if (!value.startsWith('/')) return null;
  const normalized = normalizeRequestPath(value);
  return normalized === '/' ? null : normalized;
}

export function pathMatchesBypass(requestPath: string, patterns: string[]): boolean {
  if (!patterns?.length) return false;
  for (const pattern of patterns) {
    if (!pattern || pattern === '/') continue;
    if (requestPath === pattern) return true;
    if (requestPath.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

const BASIC_AUTH_REALM = 'Restricted';

const BASIC_AUTH_MAX_FAILURES = 10;
const BASIC_AUTH_WINDOW_MS = 15 * 60 * 1000;
const BASIC_AUTH_BLOCK_MS = 15 * 60 * 1000;
const BASIC_AUTH_MAX_TRACKED = 10_000;

const BASIC_AUTH_WINDOW: ThrottleWindow = {
  maxAttempts: BASIC_AUTH_MAX_FAILURES,
  windowMs: BASIC_AUTH_WINDOW_MS,
  blockDurationMs: BASIC_AUTH_BLOCK_MS
};

interface BasicAuthFailures {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

/**
 * Constant-time string comparison that does not leak length through an early
 * return. `timingSafeEqual` throws on a length mismatch, so hash both sides
 * first and compare the digests, which are always the same size.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseBasicAuthHeader(
  header: string | undefined
): { username: string; password: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

@Injectable()
export class ProtectionService {
  private readonly jwtSecret: Uint8Array;

  private readonly frontendUrl: string;

  private readonly ingressCache = new Map<string, CachedIngress>();

  private readonly negativeCache = new Map<string, number>();

  private readonly basicAuthFailures = new Map<string, BasicAuthFailures>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly throttle: RedisThrottleService,
    private readonly crypto: SecretCryptoService
  ) {
    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
    this.frontendUrl = process.env.FRONTEND_URL || 'https://orchard.my';
  }

  async resolveIngressFromHost(host: string): Promise<CachedIngress | null> {
    const cached = this.ingressCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const negativeExpiry = this.negativeCache.get(host);
    if (negativeExpiry && negativeExpiry > Date.now()) return null;

    const ingress = await this.prisma.ingress.findFirst({
      where: {
        host,
        OR: [{ protectionMode: { not: 'none' } }, { redirectTarget: { not: null } }]
      },
      select: {
        id: true,
        projectId: true,
        namespace: true,
        protectionMode: true,
        protectionUsername: true,
        protectionPasswordHash: true,
        protectionBypassSecret: true,
        protectionBypassPaths: true,
        redirectTarget: true,
        redirectStatus: true,
        host: true,
        tlsSecretName: true,
        entrypoints: true,
        project: { select: { organizationId: true, name: true } },
        service: { select: { name: true, port: true } }
      }
    });

    if (!ingress) {
      this.negativeCache.set(host, Date.now() + 30_000);
      return null;
    }

    const entry: CachedIngress = {
      ...ingress,
      protectionBypassSecret: this.crypto.open(ingress.protectionBypassSecret),
      upstreamHost: ingress.service
        ? `${ingress.service.name}.${ingress.namespace}.svc.cluster.local`
        : null,
      upstreamPort: ingress.service?.port ?? null,
      expiresAt: Date.now() + 5_000
    };
    this.ingressCache.set(host, entry);
    return entry;
  }

  async checkProtection(
    host: string,
    originalPath: string,
    cookieHeader: string | undefined,
    bypassHeader: string | undefined,
    authorizationHeader?: string | undefined,
    clientIp?: string | undefined
  ): Promise<ProtectionDecision> {
    const ingress = await this.resolveIngressFromHost(host);
    // Fail closed. A host we cannot resolve is not a host we can vouch for,
    // and handleProxyRequest resolves the ingress separately before calling
    // this, so returning allow here would proxy to an upstream we just
    // decided we know nothing about, with no credentials checked, whenever a
    // row disappears between the two lookups.
    if (!ingress) return { allow: false, status: 404 };

    if (
      !pathIsAmbiguous(originalPath) &&
      pathMatchesBypass(normalizeRequestPath(originalPath), ingress.protectionBypassPaths)
    ) {
      return { allow: true };
    }

    const { origin, protocol } = new URL(
      ingressPublicUrl({
        host,
        path: null,
        tlsSecretName: ingress.tlsSecretName,
        entrypoints: ingress.entrypoints
      })
    );
    const secureFlag = protocol === 'https:' ? ' Secure;' : '';

    if (bypassHeader && ingress.protectionBypassSecret) {
      const a = Buffer.from(bypassHeader);
      const b = Buffer.from(ingress.protectionBypassSecret);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { allow: true };
      }
    }

    // Basic auth terminates here. There is no login page, no cookie and no
    // redirect to the control plane: the point of this mode is that it works
    // for clients that only speak `Authorization: Basic`, on clusters with no
    // Cilium to run the Envoy filter. See docs/self-hosting.md.
    if (ingress.protectionMode === 'basic') {
      const challenge: ProtectionDecision = {
        allow: false,
        status: 401,
        headers: {
          'www-authenticate': `Basic realm="${BASIC_AUTH_REALM}", charset="UTF-8"`
        }
      };

      // A request with no Authorization header is the browser asking for the
      // challenge, not a guess, so it must never count against the throttle,
      // every first visit to the site would otherwise burn an attempt.
      if (!authorizationHeader) return challenge;

      const failureKey = `${ingress.id}:${clientIp || 'unknown'}`;
      const retryAfter = await this.basicAuthRetryAfter(failureKey);
      if (retryAfter > 0) {
        return {
          allow: false,
          status: 429,
          headers: { 'retry-after': String(retryAfter) }
        };
      }

      if (await this.verifyBasicAuthHeader(ingress, authorizationHeader)) {
        await this.clearBasicAuthFailures(failureKey);
        return { allow: true };
      }

      await this.recordBasicAuthFailure(failureKey);
      return challenge;
    }

    const tokenMatch = originalPath.match(/[?&]__orchard_token=([^&]+)/);
    if (tokenMatch) {
      const exchangeToken = decodeURIComponent(tokenMatch[1]);
      const payload = await this.verifyProtectionJwt(
        exchangeToken,
        'protection_exchange',
        ingress.id
      );
      if (payload) {
        const cookieJwt = await this.generateProtectionCookie(ingress.id, payload.sub as string);
        const cleanPath =
          originalPath.replace(/[?&]__orchard_token=[^&]+/, '').replace(/\?$/, '') || '/';

        return {
          allow: false,
          status: 302,
          headers: {
            location: `${origin}${cleanPath}`,
            'set-cookie': `_orchard_protection=${cookieJwt}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=604800`
          }
        };
      }
    }

    const protectionCookie = this.extractCookie(cookieHeader, '_orchard_protection');
    if (protectionCookie) {
      const payload = await this.verifyProtectionJwt(protectionCookie, 'protection', ingress.id);
      if (payload) return { allow: true };
    }

    const returnTo = `${origin}${originalPath}`;
    const params = new URLSearchParams({
      ingressId: ingress.id,
      returnTo
    });
    if (ingress.protectionMode === 'password') {
      params.set('mode', 'password');
    }

    return {
      allow: false,
      status: 302,
      headers: {
        location: `${this.frontendUrl}/auth/protect?${params.toString()}`
      }
    };
  }

  async generateExchangeToken(ingressId: string, subject: string): Promise<string> {
    return new SignJWT({ type: 'protection_exchange', ingressId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.jwtSecret);
  }

  async generateProtectionCookie(ingressId: string, subject: string): Promise<string> {
    return new SignJWT({ type: 'protection', ingressId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);
  }

  async verifyProtectionJwt(
    token: string,
    expectedType: string,
    expectedIngressId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);
      if (payload.type !== expectedType) return null;
      if (payload.ingressId !== expectedIngressId) return null;
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async basicAuthRetryAfter(key: string): Promise<number> {
    const shared = await this.throttle.retryAfter(`basic_auth:${key}`, BASIC_AUTH_WINDOW);
    if (shared !== null) return shared;
    return this.localBasicAuthRetryAfter(key);
  }

  private async recordBasicAuthFailure(key: string): Promise<void> {
    if (await this.throttle.hit(`basic_auth:${key}`, BASIC_AUTH_WINDOW)) return;
    this.recordLocalBasicAuthFailure(key);
  }

  private async clearBasicAuthFailures(key: string): Promise<void> {
    if (await this.throttle.clear(`basic_auth:${key}`)) return;
    this.basicAuthFailures.delete(key);
  }

  private localBasicAuthRetryAfter(key: string): number {
    const entry = this.basicAuthFailures.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.blockedUntil > now) return Math.ceil((entry.blockedUntil - now) / 1000);
    if (now - entry.windowStart > BASIC_AUTH_WINDOW_MS) {
      this.basicAuthFailures.delete(key);
      return 0;
    }
    if (entry.count >= BASIC_AUTH_MAX_FAILURES) return Math.ceil(BASIC_AUTH_BLOCK_MS / 1000);
    return 0;
  }

  private recordLocalBasicAuthFailure(key: string): void {
    const now = Date.now();
    const entry = this.basicAuthFailures.get(key);
    if (!entry || now - entry.windowStart > BASIC_AUTH_WINDOW_MS) {
      this.basicAuthFailures.delete(key);
      this.pruneLocalBasicAuthFailures(now);
      this.basicAuthFailures.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= BASIC_AUTH_MAX_FAILURES) {
      entry.blockedUntil = now + BASIC_AUTH_BLOCK_MS;
    }
  }

  private pruneLocalBasicAuthFailures(now: number): void {
    if (this.basicAuthFailures.size < BASIC_AUTH_MAX_TRACKED) return;
    for (const [key, entry] of this.basicAuthFailures) {
      if (entry.blockedUntil <= now && now - entry.windowStart > BASIC_AUTH_WINDOW_MS) {
        this.basicAuthFailures.delete(key);
      }
    }
    while (this.basicAuthFailures.size >= BASIC_AUTH_MAX_TRACKED) {
      let victim: string | null = null;
      let victimStart = Infinity;
      for (const [key, entry] of this.basicAuthFailures) {
        const activeUntil = Math.max(entry.blockedUntil, entry.windowStart);
        if (activeUntil < victimStart) {
          victimStart = activeUntil;
          victim = key;
        }
      }
      if (victim === null) break;
      this.basicAuthFailures.delete(victim);
    }
  }

  private async verifyBasicAuthHeader(
    ingress: Pick<CachedIngress, 'protectionUsername' | 'protectionPasswordHash'>,
    header: string | undefined
  ): Promise<boolean> {
    // A row that lost its credentials is not an open door.
    if (!ingress.protectionUsername || !ingress.protectionPasswordHash) return false;
    const parsed = parseBasicAuthHeader(header);
    if (!parsed) return false;
    // bcrypt is the slow half, so check the username first, but without a
    // short-circuit that would let an attacker probe usernames by timing.
    const userOk = safeEqual(parsed.username, ingress.protectionUsername);
    const passOk = await bcrypt.compare(parsed.password, ingress.protectionPasswordHash);
    return userOk && passOk;
  }

  async verifyPassword(ingressId: string, password: string): Promise<boolean> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { protectionPasswordHash: true, protectionMode: true }
    });
    if (!ingress || ingress.protectionMode !== 'password' || !ingress.protectionPasswordHash) {
      return false;
    }
    return bcrypt.compare(password, ingress.protectionPasswordHash);
  }

  async checkUserAccess(ingressId: string, userId: string): Promise<boolean> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: {
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!ingress) return false;

    const access = await this.authz.resolveProjectAccess(
      ingress.projectId,
      ingress.project.organizationId,
      userId
    );
    return !!access?.canView;
  }

  async getIngressInfo(ingressId: string): Promise<{
    host: string;
    protectionMode: string;
  } | null> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: {
        host: true,
        protectionMode: true
      }
    });
    if (!ingress || ingress.protectionMode === 'none') return null;
    return {
      host: ingress.host,
      protectionMode: ingress.protectionMode
    };
  }

  async validateReturnTo(ingressId: string, returnTo: string): Promise<string> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { host: true, path: true, tlsSecretName: true, entrypoints: true }
    });
    if (!ingress) throw new NotFoundException('Domain not found');

    let url: URL;
    try {
      url = new URL(returnTo);
    } catch {
      throw new BadRequestException('Invalid returnTo URL');
    }
    if (url.origin !== new URL(ingressPublicUrl(ingress)).origin) {
      throw new BadRequestException("returnTo doesn't match the domain");
    }
    return `${url.origin}${url.pathname}${url.search}`;
  }

  async handleProxyRequest(req: Request, res: Response): Promise<boolean> {
    const host = (req.hostname || req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const ingress = await this.resolveIngressFromHost(host);
    if (!ingress) return false;

    if (ingress.redirectTarget) {
      const location = redirectLocationFor(
        req.originalUrl || req.url || '/',
        ingress.redirectTarget
      );
      res.setHeader('location', location);
      res.status(ingress.redirectStatus || 307).send('');
      return true;
    }

    const cookieHeader = req.headers['cookie']?.toString();
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    const authorizationHeader = req.headers['authorization']?.toString();
    const decision = await this.checkProtection(
      host,
      req.originalUrl || req.url,
      cookieHeader,
      bypassHeader,
      authorizationHeader,
      getClientIp(req)
    );

    if (!decision.allow) {
      if (decision.headers) {
        for (const [key, value] of Object.entries(decision.headers)) {
          res.setHeader(key, value);
        }
      }
      res.status(decision.status || 403).send('');
      return true;
    }

    if (!ingress.upstreamHost || !ingress.upstreamPort) {
      res.status(502).send('No upstream configured');
      return true;
    }

    await this.proxyToUpstream(req, res, ingress.upstreamHost, ingress.upstreamPort);
    return true;
  }

  async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const host = String(req.headers.host || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const ingress = await this.resolveIngressFromHost(host);
    if (!ingress) return false;

    if (ingress.redirectTarget) {
      const status = ingress.redirectStatus || 307;
      const label =
        status === 301
          ? 'Moved Permanently'
          : status === 302
            ? 'Found'
            : status === 307
              ? 'Temporary Redirect'
              : 'Permanent Redirect';
      const location = redirectLocationFor(req.url || '/', ingress.redirectTarget);
      try {
        socket.write(
          `HTTP/1.1 ${status} ${label}\r\nLocation: ${location}\r\nConnection: close\r\n\r\n`
        );
      } catch {}
      socket.destroy();
      return true;
    }

    const reject = (status: string) => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      } catch {}
      socket.destroy();
    };

    let allowed =
      !pathIsAmbiguous(req.url || '/') &&
      pathMatchesBypass(normalizeRequestPath(req.url || '/'), ingress.protectionBypassPaths);
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    if (!allowed && bypassHeader && ingress.protectionBypassSecret) {
      const a = Buffer.from(bypassHeader);
      const b = Buffer.from(ingress.protectionBypassSecret);
      allowed = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!allowed && ingress.protectionMode === 'basic') {
      // Browsers do not send Authorization on a WebSocket handshake, but they
      // do replay it for a same-origin upgrade once the page itself was
      // fetched with credentials, and non-browser clients set it explicitly.
      const authorizationHeader = req.headers['authorization']?.toString();
      const failureKey = `${ingress.id}:${getRawClientIp(req)}`;
      if (authorizationHeader) {
        if ((await this.basicAuthRetryAfter(failureKey)) > 0) {
          reject('429 Too Many Requests');
          return true;
        }
        allowed = await this.verifyBasicAuthHeader(ingress, authorizationHeader);
        if (allowed) await this.clearBasicAuthFailures(failureKey);
        else await this.recordBasicAuthFailure(failureKey);
      }
    }
    if (!allowed && ingress.protectionMode !== 'basic') {
      const cookie = this.extractCookie(req.headers.cookie, '_orchard_protection');
      if (cookie) {
        allowed = !!(await this.verifyProtectionJwt(cookie, 'protection', ingress.id));
      }
    }
    if (!allowed) {
      reject('401 Unauthorized');
      return true;
    }

    if (!ingress.upstreamHost || !ingress.upstreamPort) {
      reject('502 Bad Gateway');
      return true;
    }

    const upstream = net.connect(ingress.upstreamPort, ingress.upstreamHost);
    upstream.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const raw = req.rawHeaders;
      let sawForwardedFor = false;
      for (let i = 0; i < raw.length; i += 2) {
        const key = raw[i];
        const lower = key.toLowerCase();
        if (lower === 'x-orchard-protection-bypass') continue;
        if (lower === 'x-forwarded-for') {
          sawForwardedFor = true;
          const peer = req.socket?.remoteAddress;
          lines.push(`${key}: ${[raw[i + 1], peer].filter(Boolean).join(', ')}`);
          continue;
        }
        lines.push(`${key}: ${raw[i + 1]}`);
      }
      if (!sawForwardedFor && req.socket?.remoteAddress) {
        lines.push(`X-Forwarded-For: ${req.socket.remoteAddress}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => reject('502 Bad Gateway'));
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    return true;
  }

  private proxyToUpstream(
    req: Request,
    res: Response,
    upstreamHost: string,
    upstreamPort: number
  ): Promise<void> {
    return new Promise((resolve) => {
      const headers = { ...req.headers };
      delete headers['connection'];
      delete headers['x-orchard-protection-bypass'];
      delete headers['transfer-encoding'];

      const priorFor = req.headers['x-forwarded-for'];
      const peer = req.socket?.remoteAddress;
      const forwardedFor = [Array.isArray(priorFor) ? priorFor.join(', ') : priorFor, peer]
        .filter(Boolean)
        .join(', ');
      if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
      headers['x-forwarded-proto'] =
        (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
      if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

      const proxyReq = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: req.originalUrl || req.url,
          method: req.method,
          headers,
          timeout: 30_000
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
          proxyRes.on('end', resolve);
        }
      );

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Upstream timeout');
        resolve();
      });

      proxyReq.on('error', () => {
        if (!res.headersSent) res.status(502).send('Upstream error');
        resolve();
      });

      req.pipe(proxyReq);
    });
  }

  private extractCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1] : null;
  }
}
