import { Inject, Injectable } from '@nestjs/common';
import { Doors, type RateLimitDoor, type RateLimitIdentifier } from '@orchardlabs/graft-sdk/server';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

export const SANDBOX_RATE_LIMITS = {
  sandbox_share: { maxAttempts: 300, windowMs: FIFTEEN_MINUTES, blockDurationMs: FIFTEEN_MINUTES },
  sandbox_prompt: { maxAttempts: 300, windowMs: FIFTEEN_MINUTES, blockDurationMs: FIVE_MINUTES },
  sandbox_session: { maxAttempts: 60, windowMs: FIFTEEN_MINUTES, blockDurationMs: FIVE_MINUTES }
} as const;

@Injectable()
export class RateLimitService {
  constructor(@Inject(Doors.rateLimit) private readonly limits: RateLimitDoor) {
    for (const [action, config] of Object.entries(SANDBOX_RATE_LIMITS)) {
      this.limits.define(action, 'user', { ...config });
    }
  }

  async checkRateLimit(
    identifier: string,
    type: RateLimitIdentifier,
    action: string
  ): Promise<void> {
    return this.limits.check(identifier, type, action);
  }
}

@Injectable()
export class RedisThrottleService {
  constructor(@Inject(Doors.rateLimit) private readonly limits: RateLimitDoor) {}

  async consume(
    key: string,
    window: { maxAttempts: number; windowMs: number; blockDurationMs: number }
  ): Promise<number | null> {
    return this.limits.consume(key, window);
  }
}
