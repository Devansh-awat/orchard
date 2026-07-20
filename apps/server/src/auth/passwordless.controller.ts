import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { OAuthService } from './oauth.service';
import { SessionsService } from './sessions.service';
import { UsersService, sanitizeUsername } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';
import { AuditService } from '../audit/audit.service';
import { setSessionCookie } from './cookies';
import { Public, Auth } from './decorators';
import { getClientIp } from './client-ip';
import { signupMode, signupDeniedError } from './signup-mode';

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

@Public()
@Controller('auth')
export class PasswordlessController {
  constructor(
    private readonly otpService: OtpService,
    private readonly passkeyService: PasskeyService,
    private readonly oauthService: OAuthService,
    private readonly sessionsService: SessionsService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private getClientIp(req: Request): string {
    return getClientIp(req);
  }

  // H-2: cookie attributes live in ./cookies — one source of truth across
  // OAuth, SSO, and passwordless flows so SameSite/Secure stay in sync.

  /**
   * Check if a user has access to the platform (member of any org or has pending invitations).
   * SuperAdmins always have access.
   */
  private async hasPrivateBetaAccess(
    email: string,
    existingUser: { id: string; isSuperAdmin: boolean } | null,
  ): Promise<boolean> {
    if (signupMode() === 'open') return true;
    if (existingUser?.isSuperAdmin) return true;

    if (existingUser) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId: existingUser.id },
      });
      if (membership) return true;
    }

    if (signupMode() === 'closed') return false;

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        expiresAt: { gt: new Date() },
      },
    });
    return !!invitation;
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

    // Private beta: check access BEFORE creating the user so rejected
    // signups don't leave an orphan user row with zero organizations.
    const normalizedEmail = result.email.toLowerCase().trim();
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    const hasAccess = await this.hasPrivateBetaAccess(
      normalizedEmail,
      existingUser,
    );
    if (!hasAccess) {
      throw new HttpException(signupDeniedError(), HttpStatus.FORBIDDEN);
    }

    // H-1: refuse OTP login when the user's org enforces SSO.
    // H-4: even for brand-new identities, refuse OTP if the email has a
    // pending invite from an SSO-enforced org — otherwise an attacker who
    // controls the inbox can slip in before SSO is enforced.
    await this.authz.assertSsoNotEnforced(existingUser, 'otp');
    if (!existingUser) {
      await this.authz.assertSsoNotEnforcedForEmail(normalizedEmail, 'otp');
    }

    const user = existingUser ?? (await this.findOrCreateUserByEmail(result.email));

    // Create session
    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod: 'otp',
    });

    // Generate session token
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'otp',
      sessionId,
    );

    // Set cookie and respond
    setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        setupCompleted: user.setupCompleted,
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
  @Auth()
  @Post('passkey/register/options')
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
  @Auth()
  @Post('passkey/register/verify')
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

    // Private beta: reject users not invited to any organization
    const hasAccess = await this.hasPrivateBetaAccess(user.email, {
      id: user.id,
      isSuperAdmin: user.isSuperAdmin,
    });
    if (!hasAccess) {
      throw new HttpException(signupDeniedError(), HttpStatus.FORBIDDEN);
    }

    // H-1: refuse passkey login when the user's org enforces SSO.
    await this.authz.assertSsoNotEnforced(user, 'passkey');

    // Create session
    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod: 'passkey',
    });

    // Generate session token
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'passkey',
      sessionId,
    );

    // Set cookie and respond
    setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        setupCompleted: user.setupCompleted,
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
  @Auth()
  @Get('passkeys')
  async listPasskeys(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);

    const passkeys = await this.passkeyService.getUserPasskeys(user.id);
    return { passkeys };
  }

  /**
   * Delete a passkey.
   * DELETE /auth/passkeys/:id
   */
  @Auth()
  @Delete('passkeys/:id')
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
  @Auth()
  @Post('passkeys/:id/rename')
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
  // MCP Authorization
  // =====================================

  /**
   * Generate a short-lived session token for MCP authorization.
   * The user must already be authenticated (session cookie).
   * POST /auth/mcp-token
   */
  @Auth()
  @Post('mcp-token')
  async getMcpToken(@Req() req: any, @Res() res: Response) {
    const user = await this.resolveInternalUser(req.user.sub);

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    // Carry the originating session id so the MCP fetch path stays revocable.
    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      req.user.authMethod || 'otp',
      req.user.sessionId,
    );

    res.status(200).json({ token });
  }

  // =====================================
  // Session Management Endpoints
  // =====================================

  /**
   * List all active sessions for the current user.
   * GET /auth/sessions
   */
  @Auth()
  @Get('sessions')
  async listSessions(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);
    const sessions = await this.sessionsService.getUserSessions(user.id);

    // Mark the current session
    const currentSessionId = req.user.sessionId;
    return {
      sessions: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === currentSessionId,
      })),
    };
  }

  /**
   * Revoke a specific session.
   * DELETE /auth/sessions/:id
   */
  @Auth()
  @Delete('sessions/:id')
  async revokeSession(
    @Param('id') sessionId: string,
    @Req() req: any,
  ) {
    const user = await this.resolveInternalUser(req.user.sub);

    // Prevent revoking current session via this endpoint
    if (sessionId === req.user.sessionId) {
      throw new HttpException(
        'Use logout to end your current session',
        HttpStatus.BAD_REQUEST,
      );
    }

    const revoked = await this.sessionsService.revokeSession(
      user.id,
      sessionId,
    );

    if (!revoked) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    }

    return { success: true };
  }

  /**
   * Revoke all sessions except the current one.
   * POST /auth/sessions/revoke-all
   */
  @Auth()
  @Post('sessions/revoke-all')
  async revokeAllSessions(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);
    const currentSessionId = req.user.sessionId;

    const count = await this.sessionsService.revokeAllSessions(
      user.id,
      currentSessionId,
    );

    return { success: true, revokedCount: count };
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
      const baseUsername = sanitizeUsername(normalizedEmail.split('@')[0]);
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
          // H-6: this code path runs only after a successful OTP verify in
          // verifyOtp() above, so the email has just been proven owned.
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      void this.audit.log({
        action: 'user.signed_up',
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: 'user',
        targetId: user.id,
        metadata: { signup_method: 'otp' },
      });
    }

    return user;
  }
}
