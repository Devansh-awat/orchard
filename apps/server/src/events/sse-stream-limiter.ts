import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { exhaustMap, filter, from, interval, type Observable, take } from 'rxjs';
import { requestAuthStorage } from '../auth/request-context';
import { SessionsService } from '../auth/sessions.service';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_SSE_STREAMS_PER_RESOURCE = 5;
export const MAX_SSE_STREAMS_PER_USER = 20;
const ACCESS_RECHECK_MS = 15_000;

export class TooManyStreamsException extends HttpException {
  constructor(scope: 'resource' | 'user') {
    super(
      scope === 'resource'
        ? 'Too many concurrent streams for this resource'
        : 'Too many concurrent streams for this user',
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

@Injectable()
export class SseStreamLimiter {
  constructor(
    @Optional() private readonly sessions?: SessionsService,
    @Optional() private readonly prisma?: PrismaService
  ) {}

  untilAccessLost(
    auth: { sessionId?: string; apiTokenId?: string } | undefined,
    authorize: () => Promise<unknown>,
    periodMs = ACCESS_RECHECK_MS
  ): Observable<boolean> {
    const context = { ...requestAuthStorage.getStore() };
    return interval(periodMs).pipe(
      exhaustMap(() =>
        from(requestAuthStorage.run(context, () => this.stillAllowed(auth, authorize)))
      ),
      filter((allowed) => !allowed),
      take(1)
    );
  }

  private async stillAllowed(
    auth: { sessionId?: string; apiTokenId?: string } | undefined,
    authorize: () => Promise<unknown>
  ): Promise<boolean> {
    try {
      if (auth?.sessionId && !(await this.sessions?.validateSession(auth.sessionId))) return false;
      if (auth?.apiTokenId) {
        const token = await this.prisma?.apiToken.findUnique({
          where: { id: auth.apiTokenId },
          select: { expiresAt: true }
        });
        if (!token || (token.expiresAt && token.expiresAt <= new Date())) return false;
      }
      await authorize();
      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        return ![401, 403, 404].includes(error.getStatus());
      }
      return true;
    }
  }

  private readonly perResource = new Map<string, number>();

  private readonly perUser = new Map<string, number>();

  acquire(userId: string, resource: string): () => void {
    const key = `${userId}:${resource}`;
    const forResource = this.perResource.get(key) ?? 0;
    const forUser = this.perUser.get(userId) ?? 0;
    if (forResource >= MAX_SSE_STREAMS_PER_RESOURCE) throw new TooManyStreamsException('resource');
    if (forUser >= MAX_SSE_STREAMS_PER_USER) throw new TooManyStreamsException('user');
    this.perResource.set(key, forResource + 1);
    this.perUser.set(userId, forUser + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrement(this.perResource, key);
      this.decrement(this.perUser, userId);
    };
  }

  count(userId: string, resource?: string): number {
    if (resource === undefined) return this.perUser.get(userId) ?? 0;
    return this.perResource.get(`${userId}:${resource}`) ?? 0;
  }

  private decrement(map: Map<string, number>, key: string): void {
    const n = (map.get(key) ?? 1) - 1;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }
}
