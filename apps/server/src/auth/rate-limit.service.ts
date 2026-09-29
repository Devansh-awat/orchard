import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisThrottleService } from './redis-throttle.service';

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs: number;
}

export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  // OTP request: max 5 requests per email per 15 minutes, block for 1 hour
  otp_request_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 60 * 60 * 1000 // 1 hour
  },
  // OTP request: max 20 requests per IP per 15 minutes, block for 1 hour
  otp_request_ip: {
    maxAttempts: 20,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 60 * 60 * 1000 // 1 hour
  },
  // OTP verification: max 5 attempts per email per 15 minutes, block for 30 minutes
  otp_verify_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 30 * 60 * 1000 // 30 minutes
  },
  // OTP verification: max 30 attempts per IP per 15 minutes, block for 1 hour
  otp_verify_ip: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 60 * 60 * 1000 // 1 hour
  },
  // Passkey auth: max 10 attempts per email per 15 minutes, block for 30 minutes
  passkey_auth_email: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 30 * 60 * 1000 // 30 minutes
  },
  // Passkey auth: max 50 attempts per IP per 15 minutes, block for 1 hour
  passkey_auth_ip: {
    maxAttempts: 50,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 60 * 60 * 1000 // 1 hour
  },
  password_signin_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 30 * 60 * 1000 // 30 minutes
  },
  password_signin_ip: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 60 * 60 * 1000 // 1 hour
  },
  protection_password_ip: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 15 * 60 * 1000 // 15 minutes
  },
  invite_email: {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  invite_org: {
    maxAttempts: 100,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  protection_password_ingress: {
    maxAttempts: 100,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 15 * 60 * 1000 // 15 minutes
  }
};

export type RateLimitIdentifierType = 'email' | 'ip' | 'ingress' | 'org' | 'user';

@Injectable()
export class RateLimitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly throttle: RedisThrottleService
  ) {}

  private static throttleKey(
    identifier: string,
    type: RateLimitIdentifierType,
    action: string
  ): string {
    return `${action}:${type}:${identifier}`;
  }

  private static tooMany(retryAfterSeconds: number): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Too many attempts. Please try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes.`,
        retryAfter: retryAfterSeconds
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }

  /**
   * Check if an identifier is rate limited for a specific action.
   * Throws an exception if rate limited.
   */
  async checkRateLimit(
    identifier: string,
    type: RateLimitIdentifierType,
    action: string
  ): Promise<void> {
    const configKey = `${action}_${type}`;
    const config = RATE_LIMIT_CONFIGS[configKey];

    if (!config) {
      console.warn(`No rate limit config found for ${configKey}`);
      return;
    }

    const shared = await this.throttle.consume(
      RateLimitService.throttleKey(identifier, type, action),
      config
    );
    if (shared !== null) {
      if (shared > 0) throw RateLimitService.tooMany(shared);
      return;
    }

    const now = new Date();
    const key = { identifier_type_action: { identifier, type, action } };
    let record = await this.prisma.rateLimitRecord.findUnique({ where: key });
    if (!record) {
      try {
        await this.prisma.rateLimitRecord.create({
          data: { identifier, type, action, count: 1, windowStart: now }
        });
        return;
      } catch {
        record = await this.prisma.rateLimitRecord.findUnique({ where: key });
        if (!record) return;
      }
    }

    if (record.blockedUntil && record.blockedUntil > now) {
      throw RateLimitService.tooMany(
        Math.ceil((record.blockedUntil.getTime() - now.getTime()) / 1000)
      );
    }

    if (now.getTime() - record.windowStart.getTime() > config.windowMs) {
      await this.prisma.rateLimitRecord.update({
        where: { id: record.id },
        data: { count: 1, windowStart: now, blockedUntil: null }
      });
      return;
    }

    const bumped = await this.prisma.rateLimitRecord.update({
      where: { id: record.id },
      data: { count: { increment: 1 } }
    });
    if (bumped.count > config.maxAttempts) {
      const blockedUntil = new Date(now.getTime() + config.blockDurationMs);
      await this.prisma.rateLimitRecord.update({
        where: { id: record.id },
        data: { blockedUntil }
      });
      throw RateLimitService.tooMany(Math.ceil(config.blockDurationMs / 1000));
    }
  }

  /**
   * Reset rate limit on successful authentication.
   */
  async resetRateLimit(
    identifier: string,
    type: RateLimitIdentifierType,
    action: string
  ): Promise<void> {
    if (await this.throttle.clear(RateLimitService.throttleKey(identifier, type, action))) {
      return;
    }

    await this.prisma.rateLimitRecord.deleteMany({
      where: {
        identifier,
        type,
        action
      }
    });
  }

  /**
   * Clean up expired rate limit records.
   * Should be called periodically (e.g., via cron).
   */
  async cleanupExpiredRecords(): Promise<number> {
    const result = await this.prisma.rateLimitRecord.deleteMany({
      where: {
        OR: [
          // Delete records with expired blocks that haven't been updated
          {
            blockedUntil: {
              lt: new Date()
            }
          },
          // Delete records with very old windows (older than max window + block duration)
          {
            windowStart: {
              lt: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours old
            },
            blockedUntil: null
          }
        ]
      }
    });

    return result.count;
  }
}
