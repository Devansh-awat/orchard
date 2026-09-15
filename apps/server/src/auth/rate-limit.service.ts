import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  }
};

@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if an identifier is rate limited for a specific action.
   * Throws an exception if rate limited.
   */
  async checkRateLimit(identifier: string, type: 'email' | 'ip', action: string): Promise<void> {
    const configKey = `${action}_${type}`;
    const config = RATE_LIMIT_CONFIGS[configKey];

    if (!config) {
      console.warn(`No rate limit config found for ${configKey}`);
      return;
    }

    const record = await this.prisma.rateLimitRecord.findUnique({
      where: {
        identifier_type_action: {
          identifier,
          type,
          action
        }
      }
    });

    if (!record) {
      return; // No record means not rate limited
    }

    // Check if currently blocked
    if (record.blockedUntil && record.blockedUntil > new Date()) {
      const remainingSeconds = Math.ceil((record.blockedUntil.getTime() - Date.now()) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many attempts. Please try again in ${Math.ceil(remainingSeconds / 60)} minutes.`,
          retryAfter: remainingSeconds
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Check if window has expired
    const windowEnd = new Date(record.windowStart.getTime() + config.windowMs);
    if (new Date() > windowEnd) {
      // Window expired, reset will happen on increment
      return;
    }

    // Check if max attempts reached
    if (record.count >= config.maxAttempts) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many attempts. Please try again later.`,
          retryAfter: Math.ceil(config.blockDurationMs / 1000)
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  /**
   * Increment the rate limit counter for an identifier.
   * Should be called after a failed attempt.
   */
  async incrementRateLimit(
    identifier: string,
    type: 'email' | 'ip',
    action: string
  ): Promise<void> {
    const configKey = `${action}_${type}`;
    const config = RATE_LIMIT_CONFIGS[configKey];

    if (!config) {
      return;
    }

    const now = new Date();

    const existing = await this.prisma.rateLimitRecord.findUnique({
      where: {
        identifier_type_action: {
          identifier,
          type,
          action
        }
      }
    });

    if (!existing) {
      // Create new record
      await this.prisma.rateLimitRecord.create({
        data: {
          identifier,
          type,
          action,
          count: 1,
          windowStart: now
        }
      });
      return;
    }

    // Check if window has expired
    const windowEnd = new Date(existing.windowStart.getTime() + config.windowMs);

    if (now > windowEnd) {
      // Reset the window
      await this.prisma.rateLimitRecord.update({
        where: { id: existing.id },
        data: {
          count: 1,
          windowStart: now,
          blockedUntil: null
        }
      });
      return;
    }

    // Increment counter
    const newCount = existing.count + 1;
    const shouldBlock = newCount >= config.maxAttempts;

    await this.prisma.rateLimitRecord.update({
      where: { id: existing.id },
      data: {
        count: newCount,
        blockedUntil: shouldBlock ? new Date(now.getTime() + config.blockDurationMs) : null
      }
    });
  }

  /**
   * Reset rate limit on successful authentication.
   */
  async resetRateLimit(identifier: string, type: 'email' | 'ip', action: string): Promise<void> {
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
