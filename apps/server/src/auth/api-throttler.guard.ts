import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { hashApiToken } from './api-tokens.service';
import { getClientIp, isCollapsedAddress } from './client-ip';
import { getClientIp, isCollapsedAddress } from './client-ip';

const KNOWN_TOKEN_TTL_MS = 60_000;
const KNOWN_TOKEN_MAX = 10_000;

export const IP_RATE_LIMIT = 200;
export const API_TOKEN_RATE_LIMIT = 600;
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
  return isCollapsedAddress(getClientIp(req)) ? IP_RATE_LIMIT * COLLAPSED_IP_MULTIPLIER : IP_RATE_LIMIT;
}

// ThrottlerGuard that keys buckets per API token instead of per IP for
// PAT-authenticated requests, so a CLI, a TUI, and an agent sharing one host
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

  private readonly knownTokens = new Map<string, number>();

  private async tokenExists(hash: string): Promise<boolean> {
    const until = this.knownTokens.get(hash);
    if (until && until > Date.now()) return true;
    const row = await this.prisma?.apiToken
      .findUnique({ where: { tokenHash: hash }, select: { id: true } })
      .catch(() => null);
    if (!row) return false;
    if (this.knownTokens.size >= KNOWN_TOKEN_MAX) this.knownTokens.clear();
    this.knownTokens.set(hash, Date.now() + KNOWN_TOKEN_TTL_MS);
    return true;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = bearerApiToken(req);
    if (token) {
      const hash = hashApiToken(token);
      if (await this.tokenExists(hash)) return `token:${hash}`;
    }
    return getClientIp(req as any);
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
