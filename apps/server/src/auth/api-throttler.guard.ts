import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { hashApiToken } from './api-tokens.service';

export const IP_RATE_LIMIT = 200;
export const API_TOKEN_RATE_LIMIT = 600;

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
// getTracker below), so several PAT clients on one host no longer share a
// bucket; the higher limit gives each of them headroom for bursty
// SSE-driven refetch without loosening the per-IP limit for everyone else.
export function apiThrottlerLimit(context: ExecutionContext): number {
  if (context.getType() !== 'http') return IP_RATE_LIMIT;
  return bearerApiToken(context.switchToHttp().getRequest()) ? API_TOKEN_RATE_LIMIT : IP_RATE_LIMIT;
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
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = bearerApiToken(req);
    if (token) {
      return `token:${hashApiToken(token)}`;
    }
    return super.getTracker(req);
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
