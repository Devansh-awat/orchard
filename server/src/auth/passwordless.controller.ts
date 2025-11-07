import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { OAuthService } from './oauth.service';
import { UsersService } from '../users/users.service';
import { AuthGuard } from './auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

// DTOs
interface RequestOtpDto {
  email: string;
}

interface VerifyOtpDto {
  email: string;
  code: string;
}

interface RegisterPasskeyDto {
  response: any; // RegistrationResponseJSON
  friendlyName?: string;
}

interface AuthenticatePasskeyDto {
  response: any; // AuthenticationResponseJSON
}

interface UpdatePasskeyDto {
  friendlyName: string;
}

@Controller('auth')
export class PasswordlessController {
  constructor(
    private readonly otpService: OtpService,
    private readonly passkeyService: PasskeyService,
    private readonly oauthService: OAuthService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get the client IP address from the request.
   */
  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded)) {
      return forwarded[0];
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  private isSessionCookieSecure(): boolean {
    const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
    if (override === 'true') return true;
    if (override === 'false') return false;
    return process.env.NODE_ENV === 'production';
  }

  /**
   * Set the session cookie with the token.
   */
  private setSessionCookie(res: Response, token: string): void {
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: this.isSessionCookieSecure(),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
      domain: process.env.COOKIE_DOMAIN || undefined,
    });
  }

  /**
   * Resolve the internal UUID user from the request subject (which may be a Hack Club ID).
   */
  private async resolveInternalUser(userId: string) {
    const where: Prisma.UserWhereInput = { OR: [] };
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(userId)) {
      where.OR!.push({ id: userId });
    }

    // Always try Hack Club IDs as a fallback
    where.OR!.push({ hackClubId: userId });

    const user = await this.prisma.user.findFirst({ where });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    return user;
  }

  // =====================================
  // OTP Endpoints
  // =====================================

  /**
   * Request an OTP code to be sent to the email.
   * POST /auth/otp/request
   */
  @Post('otp/request')
  async requestOtp(
    @Body() body: RequestOtpDto,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const { email } = body;

    if (!email || typeof email !== 'string') {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new HttpException('Invalid email format', HttpStatus.BAD_REQUEST);
    }

    const ipAddress = this.getClientIp(req);

    return this.otpService.requestOtp(email, ipAddress);
  }

  /**
   * Verify an OTP code and sign in.
   * POST /auth/otp/verify
   */
  @Post('otp/verify')
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { email, code } = body;

    if (!email || typeof email !== 'string') {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }

    if (!code || typeof code !== 'string') {
      throw new HttpException('OTP code is required', HttpStatus.BAD_REQUEST);
    }

    const ipAddress = this.getClientIp(req);

    const result = await this.otpService.verifyOtp(email, code, ipAddress);

    if (!result.valid || !result.email) {
      throw new HttpException('Invalid OTP code', HttpStatus.UNAUTHORIZED);
    }

    // Find or create user
    const user = await this.findOrCreateUserByEmail(result.email);

    // Generate session token
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'otp',
    );

    // Set cookie and respond
    this.setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
      },
    });
  }

  // =====================================
  // Passkey Endpoints
  // =====================================

  /**
   * Check if a user has passkeys registered (for conditional UI).
   * GET /auth/passkey/check?email=user@example.com
   */
  @Get('passkey/check')
  async checkPasskeys(
    @Req() req: Request,
  ): Promise<{ hasPasskeys: boolean }> {
    const email = req.query.email as string;

    if (!email) {
      return { hasPasskeys: false };
    }

    const hasPasskeys = await this.passkeyService.userHasPasskeys(email);
    return { hasPasskeys };
  }

  /**
   * Generate passkey registration options.
   * Requires authentication (must be signed in via OTP or OAuth first).
   * POST /auth/passkey/register/options
   */
  @Post('passkey/register/options')
  @UseGuards(AuthGuard)
  async getRegistrationOptions(@Req() req: any) {
    const email = req.user.email;
    const user = await this.resolveInternalUser(req.user.sub);

    const options = await this.passkeyService.generateRegistrationOptions(
      user.id,
      email,
    );

    return options;
  }

  /**
   * Verify passkey registration and store the passkey.
   * POST /auth/passkey/register/verify
   */
  @Post('passkey/register/verify')
  @UseGuards(AuthGuard)
  async verifyRegistration(
    @Body() body: RegisterPasskeyDto,
    @Req() req: any,
  ) {
    const email = req.user.email;
    const user = await this.resolveInternalUser(req.user.sub);

    const result = await this.passkeyService.verifyRegistration(
      user.id,
      email,
      body.response,
      body.friendlyName,
    );

    return result;
  }

  /**
   * Generate passkey authentication options.
   * POST /auth/passkey/authenticate/options
   */
  @Post('passkey/authenticate/options')
  async getAuthenticationOptions(
    @Body() body: { email?: string },
    @Req() req: Request,
  ) {
    const ipAddress = this.getClientIp(req);
    const options = await this.passkeyService.generateAuthenticationOptions(
      body.email,
      ipAddress,
    );

    return options;
  }

  /**
   * Verify passkey authentication and sign in.
   * POST /auth/passkey/authenticate/verify
   */
  @Post('passkey/authenticate/verify')
  async verifyAuthentication(
    @Body() body: AuthenticatePasskeyDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ipAddress = this.getClientIp(req);

    const result = await this.passkeyService.verifyAuthentication(
      body.response,
      ipAddress,
    );

    if (!result.verified || !result.userId) {
      throw new HttpException('Authentication failed', HttpStatus.UNAUTHORIZED);
    }

    // Get user details
    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    // Generate session token
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'passkey',
    );

    // Set cookie and respond
    this.setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
      },
    });
  }

  // =====================================
  // Passkey Management Endpoints (Authenticated)
  // =====================================

  /**
   * List user's passkeys.
   * GET /auth/passkeys
   */
  @Get('passkeys')
  @UseGuards(AuthGuard)
  async listPasskeys(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);

    const passkeys = await this.passkeyService.getUserPasskeys(user.id);
    return { passkeys };
  }

  /**
   * Delete a passkey.
   * DELETE /auth/passkeys/:id
   */
  @Delete('passkeys/:id')
  @UseGuards(AuthGuard)
  async deletePasskey(
    @Param('id') passkeyId: string,
    @Req() req: any,
  ) {
    const user = await this.resolveInternalUser(req.user.sub);

    await this.passkeyService.deletePasskey(user.id, passkeyId);
    return { success: true };
  }

  /**
   * Update a passkey's friendly name.
   * PATCH /auth/passkeys/:id
   */
  @Post('passkeys/:id/rename')
  @UseGuards(AuthGuard)
  async updatePasskey(
    @Param('id') passkeyId: string,
    @Body() body: UpdatePasskeyDto,
    @Req() req: any,
  ) {
    const user = await this.resolveInternalUser(req.user.sub);

    await this.passkeyService.updatePasskeyName(
      user.id,
      passkeyId,
      body.friendlyName,
    );

    return { success: true };
  }

  // =====================================
  // Helper Methods
  // =====================================

  /**
   * Find or create a user by email (for OTP authentication).
   */
  private async findOrCreateUserByEmail(email: string) {
    const normalizedEmail = email.toLowerCase().trim();

    let user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      // Generate a unique username from email
      const baseUsername = normalizedEmail.split('@')[0];
      let username = baseUsername;
      let counter = 1;

      while (await this.prisma.user.findUnique({ where: { username } })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }

      user = await this.prisma.user.create({
        data: {
          email: normalizedEmail,
          username,
        },
      });
    }

    return user;
  }
}
