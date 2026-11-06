import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { RateLimitService } from './rate-limit.service';

export const AUTH_CLEANUP_MS = 10 * 60 * 1000;

@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  private running = false;

  constructor(
    private readonly lease: LeaseService,
    private readonly rateLimits: RateLimitService,
    private readonly otp: OtpService,
    private readonly passkeys: PasskeyService
  ) {}

  @Interval(AUTH_CLEANUP_MS)
  async tick(): Promise<void> {
    if (!this.lease.canCoordinate || !this.lease.isHolder(GLOBAL_LEADER_LEASE) || this.running) {
      return;
    }
    this.running = true;
    try {
      const results = await Promise.allSettled([
        this.rateLimits.cleanupExpiredRecords(),
        this.otp.cleanupExpiredCodes(),
        this.passkeys.cleanupExpiredChallenges()
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.warn(`pre-auth cleanup failed: ${result.reason?.message ?? result.reason}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
