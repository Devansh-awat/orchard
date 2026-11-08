import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest
} from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { hashApiToken } from './api-tokens.service';
import { getClientIp, ipBucketKey, isCollapsedAddress } from './client-ip';

const KNOWN_TOKEN_TTL_MS = 60_000;
const UNKNOWN_TOKEN_TTL_MS = 10_000;
const KNOWN_TOKEN_MAX = 10_000;

export const IP_RATE_LIMIT = 200;
export const API_TOKEN_RATE_LIMIT = 600;
export const PRINCIPAL_RATE_LIMIT = 1200;
export const PRINCIPAL_THROTTLER = 'principal';
export const COLLAPSED_IP_MULTIPLIER = 10;

// Extracts a PAT from the Authorization header. Mirrors the parsing in
// SuperAdminGuard.extractToken plus its orch_ prefix check, so the throttler
// and the auth layer always agree on what counts as a token-bearing request.
export function bearerApiToken(req: Record<string, any>): string | undefined {
  const authHeader = req?.headers?.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return undefined;
  }
  const token = authHeader.substring(7);
  return token.startsWith('orch_') ? token : undefined;
}

// Resolvable limit for ThrottlerModule. PAT buckets are per-token (see
// getTracker below), so several PAT clients on one host do not share a
// bucket; the higher limit gives each of them headroom for bursty
// SSE-driven refetch without loosening the per-IP limit for everyone else.
export function apiThrottlerLimit(context: ExecutionContext): number {
  if (context.getType() !== 'http') return IP_RATE_LIMIT;
  const req = context.switchToHttp().getRequest();
  if (bearerApiToken(req)) return API_TOKEN_RATE_LIMIT;
  return isCollapsedAddress(getClientIp(req))
    ? IP_RATE_LIMIT * COLLAPSED_IP_MULTIPLIER
    : IP_RATE_LIMIT;
}

// ThrottlerGuard that keys buckets per API token instead of per IP for
// PAT-authenticated requests, and adds a per-owner bucket across all of a
// user's tokens so minting more tokens does not buy more capacity, so a CLI, a TUI, and an agent sharing one host
// don't collide. The tracker is the token's sha256 (the same digest stored as
// ApiToken.tokenHash); the raw token is never stored or logged. Everything
// else (cookie sessions, unauthenticated traffic) keeps the trust-proxy-aware
// per-IP tracker, and @SkipThrottle / @Throttle route overrides compose
// unchanged through the base class.
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(PrismaService)
  private readonly prisma?: PrismaService;

  private readonly knownTokens = new Map<string, { userId: string | null; until: number }>();

  private async tokenOwner(hash: string): Promise<string | null> {
    const cached = this.knownTokens.get(hash);
    if (cached && cached.until > Date.now()) return cached.userId;
    const row = await this.prisma?.apiToken
      .findUnique({ where: { tokenHash: hash }, select: { id: true, userId: true } })
      .catch(() => null);
    if (this.knownTokens.size >= KNOWN_TOKEN_MAX) this.knownTokens.clear();
    const userId = row ? ((row as { userId?: string }).userId ?? hash) : null;
    this.knownTokens.set(hash, {
      userId,
      until: Date.now() + (row ? KNOWN_TOKEN_TTL_MS : UNKNOWN_TOKEN_TTL_MS)
    });
    return userId;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = bearerApiToken(req);
    if (token) {
      const hash = hashApiToken(token);
      if (await this.tokenOwner(hash)) return `token:${hash}`;
    }
    return ipBucketKey(getClientIp(req as any));
  }

  private async principalTracker(req: Record<string, any>): Promise<string> {
    const token = bearerApiToken(req);
    if (token) {
      const owner = await this.tokenOwner(hashApiToken(token));
      if (owner) return `user:${owner}`;
    }
    return ipBucketKey(getClientIp(req as any));
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    if (props.throttler.name === PRINCIPAL_THROTTLER) {
      return super.handleRequest({ ...props, getTracker: (req) => this.principalTracker(req) });
    }
    return super.handleRequest(props);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    if (context.getType() === 'http') {
      const res = context.switchToHttp().getResponse();
      if (res && typeof res.setHeader === 'function' && !res.headersSent) {
        res.setHeader('Retry-After', String(retryAfterSeconds(detail)));
      }
    }
    return super.throwThrottlingException(context, detail);
  }
}

export function retryAfterSeconds(detail: {
  timeToBlockExpire?: number;
  timeToExpire?: number;
}): number {
  const raw = Number(detail.timeToBlockExpire) > 0 ? detail.timeToBlockExpire : detail.timeToExpire;
  const secs = Math.ceil(Number(raw));
  return Number.isFinite(secs) && secs > 0 ? secs : 1;
}

export function principalThrottler() {
  return {
    name: PRINCIPAL_THROTTLER,
    ttl: 60000,
    limit: PRINCIPAL_RATE_LIMIT,
    skipIf: (context: ExecutionContext) =>
      context.getType() !== 'http' || !bearerApiToken(context.switchToHttp().getRequest())
  };
}
