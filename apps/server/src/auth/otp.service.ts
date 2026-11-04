import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RateLimitService } from './rate-limit.service';
// Shared with the host scripts, which mint a code without an email to send it
// in. Two implementations of the same hash would drift into a login link the
// server cannot verify.
import { OTP_EXPIRY_MINUTES, generateOtpCode, hashOtpCode } from './otp-code';

const MAX_VERIFICATION_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly rateLimitService: RateLimitService
  ) {}

  sendsEmail(): boolean {
    return this.emailService.isConfigured();
  }

  canDeliverCodes(): boolean {
    return this.emailService.isConfigured() || process.env.NODE_ENV !== 'production';
  }

  /**
   * Request an OTP code to be sent to the email address.
   * Implements rate limiting by email and IP.
   */
  async requestOtp(
    email: string,
    ipAddress: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.canDeliverCodes()) {
      throw new ServiceUnavailableException(
        "This instance can't send email. Sign in with your password or a passkey, or run orchardctl login on the server."
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    await this.rateLimitService.checkRateLimit(normalizedEmail, 'email', 'otp_request');
    await this.rateLimitService.checkRateLimit(ipAddress, 'ip', 'otp_request');

    // Invalidate any existing unused OTP codes for this email
    await this.prisma.otpCode.updateMany({
      where: {
        email: normalizedEmail,
        used: false,
        expiresAt: { gt: new Date() }
      },
      data: {
        used: true
      }
    });

    const plainCode = generateOtpCode();
    const hashedCode = hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await this.prisma.otpCode.create({
      data: {
        email: normalizedEmail,
        code: hashedCode,
        expiresAt,
        attempts: 0,
        used: false
      }
    });

    const emailSent = await this.emailService.sendOtpEmail({
      recipientEmail: normalizedEmail,
      otpCode: plainCode,
      expiryMinutes: OTP_EXPIRY_MINUTES
    });

    // Increment rate limit counter

    if (!emailSent) {
      if (process.env.NODE_ENV !== 'production' && !this.emailService.isConfigured()) {
        console.warn(`[dev] SMTP not configured: OTP for ${normalizedEmail}: ${plainCode}`);
      } else {
        console.warn(`Failed to send OTP email to ${normalizedEmail}`);
        // Still return success to avoid email enumeration
      }
    }

    return {
      success: true,
      message: "If an account exists with this email, you'll get a code shortly."
    };
  }

  /**
   * Verify an OTP code and return the associated email if valid.
   * Implements rate limiting and brute force protection.
   */
  async verifyOtp(
    email: string,
    code: string,
    ipAddress: string
  ): Promise<{ valid: boolean; email?: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedCode = code.trim();

    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new BadRequestException('Enter the 6-digit code.');
    }

    await this.rateLimitService.checkRateLimit(normalizedEmail, 'email', 'otp_verify');
    await this.rateLimitService.checkRateLimit(ipAddress, 'ip', 'otp_verify');

    const hashedCode = hashOtpCode(normalizedCode);

    // Find the most recent valid OTP for this email
    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        email: normalizedEmail,
        used: false,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!otpRecord) {
      return { valid: false };
    }

    const claimed = await this.prisma.otpCode.updateMany({
      where: { id: otpRecord.id, used: false, attempts: { lt: MAX_VERIFICATION_ATTEMPTS } },
      data: { attempts: { increment: 1 } }
    });
    if (claimed.count === 0) {
      await this.prisma.otpCode.updateMany({
        where: { id: otpRecord.id },
        data: { used: true }
      });
      throw new BadRequestException('Too many attempts. Request a new code.');
    }

    // Use timing-safe comparison to prevent timing attacks
    const isValid = this.timingSafeCompare(hashedCode, otpRecord.code);

    if (!isValid) {
      // Increment rate limit on failure
      return { valid: false };
    }

    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { used: true }
    });

    // H-6: a successful OTP verification proves ownership of the email
    // address. Flip the User.emailVerified flag if a row already exists for
    // this address. updateMany is a no-op when the user has not yet been
    // created (first-time signups are created post-verify by the controller
    // with emailVerified=true), so this is safe for both flows.
    await this.prisma.user.updateMany({
      where: { email: normalizedEmail, emailVerified: false },
      data: { emailVerified: true, emailVerifiedAt: new Date() }
    });

    await this.rateLimitService.resetRateLimit(normalizedEmail, 'email', 'otp_verify');
    await this.rateLimitService.resetRateLimit(ipAddress, 'ip', 'otp_verify');

    return { valid: true, email: normalizedEmail };
  }

  /**
   * Timing-safe string comparison to prevent timing attacks.
   */
  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Clean up expired OTP codes.
   * Should be called periodically (e.g., via cron).
   */
  async cleanupExpiredCodes(): Promise<number> {
    const result = await this.prisma.otpCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { used: true, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
        ]
      }
    });

    return result.count;
  }
}
