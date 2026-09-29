import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

export const MAX_SSE_STREAMS_PER_RESOURCE = 5;
export const MAX_SSE_STREAMS_PER_USER = 20;

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
