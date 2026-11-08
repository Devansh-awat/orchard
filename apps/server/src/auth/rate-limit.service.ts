import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisThrottleService } from './redis-throttle.service';
import { normalizeEmail } from './email-normalize';
import { ipBucketKey, isCollapsedAddress } from './client-ip';

export const COLLAPSED_IP_MULTIPLIER = 10;
export const COLLAPSED_IP_MAX_BLOCK_MS = 5 * 60 * 1000;
export const CLEANUP_BATCH = 1000;
export const CLEANUP_MAX_BATCHES = 20;
export const MAX_BUCKET_IDENTIFIER_LENGTH = 128;
export const PRESSURE_DELAY_MS = 1000;
export const PRESSURE_MAX_SLEEPERS = 500;

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs: number;
}

export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  // OTP request: max 5 requests per email per 15 minutes, block for 1 hour
  otp_request_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  // OTP request: max 20 requests per IP per 15 minutes, block for 1 hour
  otp_request_ip: {
    maxAttempts: 20,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  // OTP verification: max 5 attempts per email per 15 minutes, block for 30 minutes
  // OTP sends: at most 8 mails per address and 40 per IP per hour, whatever the
  // 15 minute windows above allow, block for 1 hour
  otp_send_email: {
    maxAttempts: 8,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  otp_send_ip: {
    maxAttempts: 40,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  otp_verify_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 30 * 60 * 1000
  },
  // OTP verification: max 30 attempts per IP per 15 minutes, block for 1 hour
  otp_verify_ip: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  // Passkey auth: max 10 attempts per email per 15 minutes, block for 30 minutes
  passkey_auth_email: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 30 * 60 * 1000
  },
  // Passkey auth: max 50 attempts per IP per 15 minutes, block for 1 hour
  passkey_auth_ip: {
    maxAttempts: 50,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  password_signin_email: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 30 * 60 * 1000
  },
  password_signin_ip: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  protection_password_ip: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000
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
  invite_user: {
    maxAttempts: 30,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  invite_global: {
    maxAttempts: 2000,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000
  },
  mcp_register_ip: {
    maxAttempts: 20,
    windowMs: 24 * 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },
  mcp_register_global: {
    maxAttempts: 5000,
    windowMs: 24 * 60 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000
  },
  otp_request_global: {
    maxAttempts: 3000,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },
  otp_verify_global: {
    maxAttempts: 6000,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },
  passkey_auth_global: {
    maxAttempts: 6000,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },
  password_signin_global: {
    maxAttempts: 6000,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },
  protection_password_global: {
    maxAttempts: 6000,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },
  protection_password_ingress: {
    maxAttempts: 100,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000
  }
};

export type RateLimitIdentifierType = 'email' | 'ip' | 'ingress' | 'org' | 'user' | 'global';

@Injectable()
export class RateLimitService {
  private sleepers = 0;

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

  static bucketIdentifier(identifier: string, type: RateLimitIdentifierType): string {
    let value = String(identifier);
    if (type === 'ip') value = ipBucketKey(value.slice(0, 256));
    else if (type === 'email') value = normalizeEmail(value);
    if (value.length <= MAX_BUCKET_IDENTIFIER_LENGTH) return value;
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  private static tooMany(retryAfterSeconds: number): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes.`,
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
    let config = RATE_LIMIT_CONFIGS[configKey];

    if (!config) {
      console.warn(`No rate limit config found for ${configKey}`);
      return;
    }

    if (type === 'ip' && isCollapsedAddress(identifier)) {
      config = {
        maxAttempts: config.maxAttempts * COLLAPSED_IP_MULTIPLIER,
        windowMs: config.windowMs,
        blockDurationMs: Math.min(config.blockDurationMs, COLLAPSED_IP_MAX_BLOCK_MS)
      };
    }

    await this.consume(RateLimitService.bucketIdentifier(identifier, type), type, action, config);
  }

  /**
   * Check the per-source buckets for one request (the caller's address first,
   * then each identity), and only when all of them pass charge the global
   * ceiling for the action. The ceiling is a pressure signal, never a block:
   * a source that is rejected on its own bucket cannot spend it, and crossing
   * it asks the controller for a step-up instead of locking everyone out.
   */
  async checkRateLimits(
    action: string,
    subjects: {
      ip?: string;
      identities?: Array<[string, RateLimitIdentifierType]>;
    }
  ): Promise<{ pressured: boolean }> {
    if (subjects.ip) await this.checkRateLimit(subjects.ip, 'ip', action);
    for (const [identifier, type] of subjects.identities ?? []) {
      await this.checkRateLimit(identifier, type, action);
    }
    const ceiling = RATE_LIMIT_CONFIGS[`${action}_global`];
    if (!ceiling) return { pressured: false };
    try {
      await this.consume('all', 'global', action, ceiling);
      return { pressured: false };
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return { pressured: true };
      }
      throw e;
    }
  }

  async checkInviteMail(subjects: {
    email?: string;
    organizationId?: string;
    userId?: string;
  }): Promise<void> {
    if (subjects.email) await this.checkRateLimit(subjects.email, 'email', 'invite');
    if (subjects.organizationId)
      await this.checkRateLimit(subjects.organizationId, 'org', 'invite');
    if (subjects.userId) await this.checkRateLimit(subjects.userId, 'user', 'invite');
    await this.checkRateLimit('all', 'global', 'invite');
  }

  async slowDown(): Promise<void> {
    if (this.sleepers >= PRESSURE_MAX_SLEEPERS) return;
    this.sleepers += 1;
    try {
      const delay = PRESSURE_DELAY_MS + Math.floor(Math.random() * PRESSURE_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      this.sleepers -= 1;
    }
  }

  private async consume(
    identifier: string,
    type: RateLimitIdentifierType,
    action: string,
    config: RateLimitConfig
  ): Promise<void> {
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
    rawIdentifier: string,
    type: RateLimitIdentifierType,
    action: string
  ): Promise<void> {
    const identifier = RateLimitService.bucketIdentifier(rawIdentifier, type);
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

  async cleanupExpiredRecords(): Promise<number> {
    const now = Date.now();
    let total = 0;
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      const stale = await this.prisma.rateLimitRecord.findMany({
        where: {
          OR: [
            { blockedUntil: { lt: new Date(now) } },
            { windowStart: { lt: new Date(now - 2 * 60 * 60 * 1000) }, blockedUntil: null }
          ]
        },
        select: { id: true },
        take: CLEANUP_BATCH
      });
      if (stale.length === 0) break;
      const result = await this.prisma.rateLimitRecord.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } }
      });
      total += result.count;
      if (stale.length < CLEANUP_BATCH) break;
    }
    return total;
  }
}
