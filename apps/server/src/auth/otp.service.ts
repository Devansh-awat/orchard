import { Injectable, BadRequestException } from '@nestjs/common';
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

  /**
   * Request an OTP code to be sent to the email address.
   * Implements rate limiting by email and IP.
   */
  async requestOtp(
    email: string,
    ipAddress: string
  ): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Check rate limits for both email and IP
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
        used: true // Mark as used so they can't be used
      }
    });

    // Generate new OTP
    const plainCode = generateOtpCode();
    const hashedCode = hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store the hashed OTP
    await this.prisma.otpCode.create({
      data: {
        email: normalizedEmail,
        code: hashedCode,
        expiresAt,
        attempts: 0,
        used: false
      }
    });

    // Send OTP email
    const emailSent = await this.emailService.sendOtpEmail({
      recipientEmail: normalizedEmail,
      otpCode: plainCode,
      expiryMinutes: OTP_EXPIRY_MINUTES
    });

    // Increment rate limit counter
    await this.rateLimitService.incrementRateLimit(normalizedEmail, 'email', 'otp_request');
    await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'otp_request');

    if (!emailSent) {
      if (process.env.NODE_ENV !== 'production' && !this.emailService.isConfigured()) {
        console.warn(`[dev] SMTP not configured — OTP for ${normalizedEmail}: ${plainCode}`);
      } else {
        console.warn(`Failed to send OTP email to ${normalizedEmail}`);
        // Still return success to avoid email enumeration
      }
    }

    return {
      success: true,
      message: 'If an account exists with this email, you will receive an OTP code shortly.'
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

    // Validate code format
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new BadRequestException('Invalid OTP format. Must be 6 digits.');
    }

    // Check rate limits
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
      // Increment rate limit on failure
      await this.rateLimitService.incrementRateLimit(normalizedEmail, 'email', 'otp_verify');
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'otp_verify');
      return { valid: false };
    }

    // Check if max attempts exceeded for this specific OTP
    if (otpRecord.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      // Mark as used to prevent further attempts
      await this.prisma.otpCode.update({
        where: { id: otpRecord.id },
        data: { used: true }
      });
      throw new BadRequestException(
        'Maximum verification attempts exceeded. Please request a new code.'
      );
    }

    // Increment attempt counter
    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } }
    });

    // Use timing-safe comparison to prevent timing attacks
    const isValid = this.timingSafeCompare(hashedCode, otpRecord.code);

    if (!isValid) {
      // Increment rate limit on failure
      await this.rateLimitService.incrementRateLimit(normalizedEmail, 'email', 'otp_verify');
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'otp_verify');
      return { valid: false };
    }

    // Mark OTP as used
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

    // Reset rate limits on success
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
