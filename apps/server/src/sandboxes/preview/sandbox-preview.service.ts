import * as http from 'http';
import type { Duplex } from 'stream';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { InstanceSettingsService } from '../../instance-settings/instance-settings.service';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, refOf } from '../runners/sandbox-runner';
import { SandboxAccess, SandboxAccessService } from '../sandbox-access.service';
import { SandboxLiveService } from '../live/sandbox-live.service';
import { TokenBucket } from '../live/live-protocol';
import {
  PREVIEW_EXCHANGE_PATH,
  PreviewCookiePayload,
  PreviewHost,
  declaredPreviewPorts,
  isPreviewPortAllowed,
  isPreviewPortCandidate,
  mintPreviewToken,
  parsePreviewHost,
  previewCookieHeader,
  previewCookieValues,
  previewDownstreamHeaders,
  previewOriginFor,
  previewRequestAllowed,
  previewUpstreamHeaders,
  redeemPreviewToken,
  sandboxMatchesId8,
  signPreviewCookie,
  verifyPreviewCookie
} from './preview-auth';
import { configuredPreviewDomain } from './preview-domain';

const ACCESS_CACHE_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 120_000;

export interface PreviewLink {
  url: string;
  public: boolean;
  expiresAt: string | null;
}

function plain(res: http.ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(message);
}

function rawReject(socket: Duplex, status: number, message: string) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

@Injectable()
export class SandboxPreviewService {
  private readonly logger = new Logger(SandboxPreviewService.name);

  private readonly mintLimits = new Map<string, TokenBucket>();

  private readonly accessCache = new Map<string, { ok: boolean; until: number }>();

  private domainCache: { generation: number; value: string | null } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InstanceConfigService,
    private readonly settings: InstanceSettingsService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly access: SandboxAccessService,
    private readonly live: SandboxLiveService
  ) {}

  private secret(): string | null {
    const secret = process.env.JWT_SECRET || '';
    return secret.length >= 16 ? secret : null;
  }

  domain(): string | null {
    const generation = this.config.generation;
    if (this.domainCache && this.domainCache.generation === generation) {
      return this.domainCache.value;
    }
    const resolved = configuredPreviewDomain(this.config);
    if (resolved.conflict) this.logger.warn(`sandbox previews disabled: ${resolved.conflict}`);
    this.domainCache = { generation, value: resolved.domain };
    return resolved.domain;
  }

  private takeMint(userId: string): boolean {
    let bucket = this.mintLimits.get(userId);
    if (!bucket) {
      if (this.mintLimits.size > 10_000) this.mintLimits.clear();
      bucket = new TokenBucket(0.5, 20);
      this.mintLimits.set(userId, bucket);
    }
    return bucket.take();
  }

  async link(access: SandboxAccess, port: number): Promise<PreviewLink> {
    const sandbox = access.sandbox;
    const runner = this.registry.for(sandbox);
    const declared = runner.id === 'vercel' ? [] : declaredPreviewPorts(sandbox.runnerState);
    if (!Number.isInteger(port) || !isPreviewPortAllowed(port, declared)) {
      throw new BadRequestException('That port cannot be previewed');
    }
    if (sandbox.status !== 'running') throw new BadRequestException('Sandbox is not running');
    if (!this.takeMint(access.userId)) {
      throw new HttpException(
        'Too many preview links, try again shortly',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (runner.id === 'vercel') {
      const target = await runner.httpTarget(refOf(sandbox), port);
      if (target.kind !== 'url') throw new ServiceUnavailableException('Preview is unavailable');
      return { url: target.baseUrl, public: true, expiresAt: null };
    }
    const domain = this.domain();
    if (!domain) {
      throw new ServiceUnavailableException(
        'Previews need a preview domain; an admin can set previewDomain in instance settings'
      );
    }
    const secret = this.secret();
    if (!secret) throw new ServiceUnavailableException('Previews need JWT_SECRET to be configured');
    const token = await mintPreviewToken(this.live.backend, secret, {
      sandboxId: sandbox.id,
      userId: access.userId,
      port
    });
    const url = `${previewOriginFor(sandbox.id, port, domain)}${PREVIEW_EXCHANGE_PATH}?token=${encodeURIComponent(token)}`;
    return { url, public: false, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  private async stillAllowed(sandboxId: string, userId: string): Promise<boolean> {
    const key = `${sandboxId}:${userId}`;
    const cached = this.accessCache.get(key);
    const now = Date.now();
    if (cached && cached.until > now) return cached.ok;
    const resolved = await this.access.resolve(sandboxId, userId).catch(() => null);
    const ok = !!resolved && resolved.sandbox.desiredState !== 'deleted';
    if (this.accessCache.size > 10_000) this.accessCache.clear();
    this.accessCache.set(key, { ok, until: now + ACCESS_CACHE_MS });
    return ok;
  }

  private match(hostHeader: string | undefined): { host: PreviewHost; domain: string } | null {
    const domain = this.domain();
    if (!domain) return null;
    const host = parsePreviewHost(hostHeader, domain);
    return host ? { host, domain } : null;
  }

  isPreviewHost(hostHeader: string | undefined): boolean {
    return this.match(hostHeader) !== null;
  }

  private cookiePayload(req: http.IncomingMessage, host: PreviewHost): PreviewCookiePayload | null {
    const secret = this.secret();
    if (!secret) return null;
    for (const value of previewCookieValues(req.headers.cookie)) {
      const payload = verifyPreviewCookie(secret, value, host);
      if (payload) return payload;
    }
    return null;
  }

  private async upstream(sandboxId: string, port: number): Promise<Duplex | 'port' | null> {
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { ...SANDBOX_REF_SELECT, status: true, desiredState: true }
    });
    if (!row || row.status !== 'running' || row.desiredState === 'deleted') return null;
    const runner = this.registry.for(row);
    if (runner.id === 'vercel') return null;
    if (!isPreviewPortAllowed(port, declaredPreviewPorts(row.runnerState))) return 'port';
    return runner.openTcp(refOf(row), port);
  }

  async handleRequest(req: Request, res: Response): Promise<boolean> {
    const matched = this.match(req.headers.host);
    if (!matched) return false;
    const { host, domain } = matched;
    if (!(await this.settings.isSandboxesEnabled().catch(() => false))) {
      plain(res, 404, 'Not found');
      return true;
    }
    if (!isPreviewPortCandidate(host.port)) {
      plain(res, 404, 'Not found');
      return true;
    }
    const url = new URL(req.originalUrl || req.url || '/', 'http://preview.invalid');
    if (url.pathname === PREVIEW_EXCHANGE_PATH) {
      await this.exchange(res, host, url.searchParams.get('token') || '');
      return true;
    }
    const payload = this.cookiePayload(req, host);
    if (!payload || !(await this.stillAllowed(payload.sid, payload.uid))) {
      plain(res, 401, 'This preview link has expired. Open it again from Greenhouse.');
      return true;
    }
    if (!previewRequestAllowed(req.headers, host, domain, req.method)) {
      plain(res, 403, 'Cross-site requests to previews are not allowed');
      return true;
    }
    let socket: Duplex | 'port' | null;
    try {
      socket = await this.upstream(payload.sid, host.port);
    } catch (e: any) {
      this.logger.debug(`preview upstream failed: ${e?.message}`);
      socket = null;
    }
    if (socket === 'port') {
      plain(res, 404, 'That port cannot be previewed');
      return true;
    }
    if (!socket) {
      plain(res, 502, 'Nothing is answering on this port in the sandbox');
      return true;
    }
    await this.forward(req, res, host, socket);
    return true;
  }

  private async exchange(res: Response, host: PreviewHost, token: string) {
    const secret = this.secret();
    const payload = secret
      ? await redeemPreviewToken(this.live.backend, secret, token, host).catch(() => null)
      : null;
    if (!payload || !secret || !sandboxMatchesId8(payload.sid, host.id8)) {
      plain(
        res,
        401,
        'This preview link has expired or was already used. Open it again from Greenhouse.'
      );
      return;
    }
    this.accessCache.delete(`${payload.sid}:${payload.uid}`);
    if (!(await this.stillAllowed(payload.sid, payload.uid))) {
      plain(res, 403, 'You no longer have access to this sandbox');
      return;
    }
    const cookie = signPreviewCookie(secret, {
      sandboxId: payload.sid,
      userId: payload.uid,
      port: host.port,
      host: host.host
    });
    res.writeHead(302, {
      location: '/',
      'set-cookie': previewCookieHeader(cookie),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    });
    res.end();
  }

  private forward(req: Request, res: Response, host: PreviewHost, socket: Duplex): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const proxyReq = http.request({
        method: req.method,
        path: req.originalUrl || req.url || '/',
        headers: previewUpstreamHeaders(req.headers, host, req.ip),
        createConnection: () => socket as any,
        timeout: UPSTREAM_TIMEOUT_MS
      });
      proxyReq.on('response', (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, previewDownstreamHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on('end', done);
        proxyRes.on('error', () => {
          res.end();
          done();
        });
      });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('preview upstream timed out')));
      proxyReq.on('error', () => {
        plain(res, 502, 'Nothing is answering on this port in the sandbox');
        done();
      });
      res.on('close', () => {
        proxyReq.destroy();
        socket.destroy();
        done();
      });
      req.pipe(proxyReq);
    });
  }

  async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const matched = this.match(req.headers.host);
    if (!matched) return false;
    const { host, domain } = matched;
    if (
      !isPreviewPortCandidate(host.port) ||
      !(await this.settings.isSandboxesEnabled().catch(() => false))
    ) {
      rawReject(socket, 404, 'Not Found');
      return true;
    }
    const payload = this.cookiePayload(req, host);
    if (!payload || !(await this.stillAllowed(payload.sid, payload.uid))) {
      rawReject(socket, 401, 'Unauthorized');
      return true;
    }
    if (!previewRequestAllowed(req.headers, host, domain, req.method || 'GET')) {
      rawReject(socket, 403, 'Forbidden');
      return true;
    }
    let target: Duplex | 'port' | null;
    try {
      target = await this.upstream(payload.sid, host.port);
    } catch {
      target = null;
    }
    if (target === 'port') {
      rawReject(socket, 404, 'Not Found');
      return true;
    }
    if (!target) {
      rawReject(socket, 502, 'Bad Gateway');
      return true;
    }
    const upstream: Duplex = target;
    const headers = previewUpstreamHeaders(req.headers, host, req.socket.remoteAddress);
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade || 'websocket');
    const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (/[\r\n]/.test(v)) continue;
        lines.push(`${name}: ${v}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    const teardown = () => {
      socket.destroy();
      upstream?.destroy();
    };
    upstream.on('error', teardown);
    socket.on('error', teardown);
    upstream.on('close', teardown);
    socket.on('close', teardown);
    upstream.pipe(socket);
    socket.pipe(upstream);
    return true;
  }
}
