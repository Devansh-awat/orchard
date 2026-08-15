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

export interface ProtectionDecision {
  allow: boolean;
  status?: number;
  headers?: Record<string, string>;
}

interface CachedIngress {
  id: string;
  projectId: string;
  protectionMode: string;
  protectionPasswordHash: string | null;
  protectionBypassSecret: string | null;
  protectionBypassPaths: string[];
  project: { organizationId: string; name: string };
  host: string;
  upstreamHost: string | null;
  upstreamPort: number | null;
  expiresAt: number;
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

@Injectable()
export class ProtectionService {
  private readonly jwtSecret: Uint8Array;

  private readonly frontendUrl: string;

  private readonly ingressCache = new Map<string, CachedIngress>();

  private readonly negativeCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
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
      where: { host, protectionMode: { not: 'none' } },
      select: {
        id: true,
        projectId: true,
        namespace: true,
        protectionMode: true,
        protectionPasswordHash: true,
        protectionBypassSecret: true,
        protectionBypassPaths: true,
        host: true,
        project: { select: { organizationId: true, name: true } },
        service: { select: { name: true, port: true } },
      },
    });

    if (!ingress) {
      this.negativeCache.set(host, Date.now() + 30_000);
      return null;
    }

    const entry: CachedIngress = {
      ...ingress,
      upstreamHost: ingress.service ? `${ingress.service.name}.${ingress.namespace}.svc.cluster.local` : null,
      upstreamPort: ingress.service?.port ?? null,
      expiresAt: Date.now() + 5_000,
    };
    this.ingressCache.set(host, entry);
    return entry;
  }

  async checkProtection(
    host: string,
    originalPath: string,
    cookieHeader: string | undefined,
    bypassHeader: string | undefined,
  ): Promise<ProtectionDecision> {
    const ingress = await this.resolveIngressFromHost(host);
    // Fail closed. A host we cannot resolve is not a host we can vouch for,
    // and handleProxyRequest resolves the ingress separately before calling
    // this — so returning allow here would proxy to an upstream we just
    // decided we know nothing about, with no credentials checked, whenever a
    // row disappears between the two lookups.
    if (!ingress) return { allow: false, status: 404 };

    if (pathMatchesBypass(normalizeRequestPath(originalPath), ingress.protectionBypassPaths)) {
      return { allow: true };
    }

    if (bypassHeader && ingress.protectionBypassSecret) {
      const a = Buffer.from(bypassHeader);
      const b = Buffer.from(ingress.protectionBypassSecret);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { allow: true };
      }
    }

    const tokenMatch = originalPath.match(/[?&]__orchard_token=([^&]+)/);
    if (tokenMatch) {
      const exchangeToken = decodeURIComponent(tokenMatch[1]);
      const payload = await this.verifyProtectionJwt(exchangeToken, 'protection_exchange', ingress.id);
      if (payload) {
        const cookieJwt = await this.generateProtectionCookie(ingress.id, payload.sub as string);
        const cleanPath = originalPath
          .replace(/[?&]__orchard_token=[^&]+/, '')
          .replace(/\?$/, '') || '/';

        return {
          allow: false,
          status: 302,
          headers: {
            location: `https://${host}${cleanPath}`,
            'set-cookie': `_orchard_protection=${cookieJwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
          },
        };
      }
    }

    const protectionCookie = this.extractCookie(cookieHeader, '_orchard_protection');
    if (protectionCookie) {
      const payload = await this.verifyProtectionJwt(protectionCookie, 'protection', ingress.id);
      if (payload) return { allow: true };
    }

    const returnTo = `https://${host}${originalPath}`;
    const params = new URLSearchParams({
      ingressId: ingress.id,
      returnTo,
    });
    if (ingress.protectionMode === 'password') {
      params.set('mode', 'password');
    }

    return {
      allow: false,
      status: 302,
      headers: {
        location: `${this.frontendUrl}/auth/protect?${params.toString()}`,
      },
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
    expectedIngressId: string,
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

  async verifyPassword(ingressId: string, password: string): Promise<boolean> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { protectionPasswordHash: true, protectionMode: true },
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
        project: { select: { organizationId: true } },
      },
    });
    if (!ingress) return false;

    const access = await this.authz.resolveProjectAccess(
      ingress.projectId,
      ingress.project.organizationId,
      userId,
    );
    return !!access?.canView;
  }

  async getIngressInfo(ingressId: string): Promise<{
    host: string;
    protectionMode: string;
    projectName: string;
  } | null> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: {
        host: true,
        protectionMode: true,
        project: { select: { name: true } },
      },
    });
    if (!ingress || ingress.protectionMode === 'none') return null;
    return {
      host: ingress.host,
      protectionMode: ingress.protectionMode,
      projectName: ingress.project.name,
    };
  }

  async validateReturnTo(ingressId: string, returnTo: string): Promise<void> {
    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { host: true },
    });
    if (!ingress) throw new NotFoundException('Ingress not found');

    let url: URL;
    try {
      url = new URL(returnTo);
    } catch {
      throw new BadRequestException('Invalid returnTo URL');
    }
    if (url.hostname !== ingress.host) {
      throw new BadRequestException('returnTo does not match ingress host');
    }
  }

  async handleProxyRequest(req: Request, res: Response): Promise<boolean> {
    const host = (req.hostname || req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const ingress = await this.resolveIngressFromHost(host);
    if (!ingress) return false;

    const cookieHeader = req.headers['cookie']?.toString();
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    const decision = await this.checkProtection(host, req.originalUrl || req.url, cookieHeader, bypassHeader);

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
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const ingress = await this.resolveIngressFromHost(host);
    if (!ingress) return false;

    const reject = (status: string) => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      } catch {}
      socket.destroy();
    };

    let allowed = pathMatchesBypass(
      normalizeRequestPath(req.url || '/'),
      ingress.protectionBypassPaths,
    );
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    if (!allowed && bypassHeader && ingress.protectionBypassSecret) {
      const a = Buffer.from(bypassHeader);
      const b = Buffer.from(ingress.protectionBypassSecret);
      allowed = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!allowed) {
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

  private proxyToUpstream(req: Request, res: Response, upstreamHost: string, upstreamPort: number): Promise<void> {
    return new Promise((resolve) => {
      const headers = { ...req.headers };
      delete headers['connection'];
      delete headers['x-orchard-protection-bypass'];
      delete headers['transfer-encoding'];

      const priorFor = req.headers['x-forwarded-for'];
      const peer = req.socket?.remoteAddress;
      const forwardedFor = [
        Array.isArray(priorFor) ? priorFor.join(', ') : priorFor,
        peer,
      ].filter(Boolean).join(', ');
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
          timeout: 30_000,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
          proxyRes.on('end', resolve);
        },
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
