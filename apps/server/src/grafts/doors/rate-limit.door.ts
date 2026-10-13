import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import {
  RATE_LIMIT_CONFIGS,
  RateLimitService,
  type RateLimitConfig
} from '../../auth/rate-limit.service';
import { RedisThrottleService } from '../../auth/redis-throttle.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

type IdentifierType = Parameters<RateLimitService['checkRateLimit']>[1];

@Injectable({ scope: Scope.TRANSIENT })
export class RateLimitDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'rateLimit',
    version: 1,
    status: 'stable',
    capability: 'rateLimit'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef
  ) {
    this.graft = bindGraft(parent, RateLimitDoorV1.meta);
  }

  private get limits(): RateLimitService {
    return this.moduleRef.get(RateLimitService, { strict: false });
  }

  private get throttle(): RedisThrottleService {
    return this.moduleRef.get(RedisThrottleService, { strict: false });
  }

  define(action: string, type: IdentifierType, config: RateLimitConfig): void {
    assertClaimed(this.graft, 'rateLimitBuckets', action, 'rate limit bucket');
    RATE_LIMIT_CONFIGS[`${action}_${type}`] = { ...config };
  }

  check(identifier: string, type: IdentifierType, action: string): Promise<void> {
    assertClaimed(this.graft, 'rateLimitBuckets', action, 'rate limit bucket');
    return this.limits.checkRateLimit(identifier, type, action);
  }

  consume(key: string, window: Parameters<RedisThrottleService['consume']>[1]) {
    assertClaimed(this.graft, 'rateLimitBuckets', key.split(':')[0], 'rate limit bucket');
    return this.throttle.consume(key, window);
  }
}
