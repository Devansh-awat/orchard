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
  HttpStatus
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { OtpService } from './otp.service';
import { RateLimitService } from './rate-limit.service';
import { TurnstileService } from './turnstile.service';
import {
  PasswordRefused,
  setAccountPassword,
  setSuperadminPassword,
  superadminHasPassword,
  verifySuperadminPassword
} from './superadmin-password';
import { PasskeyService } from './passkey.service';
import { OAuthService } from './oauth.service';
import { SessionsService } from './sessions.service';
import { UsersService, sanitizeUsername } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';
import { AuditService } from '../audit/audit.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { setSessionCookie } from './cookies';
import { Public, Auth } from './decorators';
import { getClientIp } from './client-ip';
import { signupMode, signupDeniedError } from './signup-mode';
import { signedInUser } from './signed-in-user';

interface RequestOtpDto {
  email: string;
}

interface VerifyOtpDto {
  email: string;
  code: string;
}

interface PasswordDto {
  email: string;
  password: string;
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
    private readonly rateLimit: RateLimitService,
    private readonly turnstile: TurnstileService,
    private readonly instanceSettings: InstanceSettingsService
  ) {}

  private getClientIp(req: Request): string {
    return getClientIp(req);
  }

  // H-2: cookie attributes live in ./cookies: one source of truth across
  // OAuth, SSO, and passwordless flows so SameSite/Secure stay in sync.

  /**
   * Check if a user has access to the platform (member of any org or has pending invitations).
   * SuperAdmins always have access.
   */
  private async hasPrivateBetaAccess(
    email: string,
    existingUser: { id: string; isSuperAdmin: boolean } | null
  ): Promise<boolean> {
    if (signupMode() === 'open') return true;
    if (existingUser?.isSuperAdmin) return true;

    if (existingUser) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId: existingUser.id }
      });
      if (membership) return true;
    }

    if (signupMode() === 'closed') return false;

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        expiresAt: { gt: new Date() }
      }
    });
    return !!invitation;
  }

  /**
   * Resolve the internal UUID user from the request subject (which may be a Hack Club ID).
   */
  private async resolveInternalUser(userId: string) {
    const where: Prisma.UserWhereInput = { OR: [] };
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(userId)) {
      where.OR!.push({ id: userId });
    }

    // Always try Hack Club IDs as a fallback
    where.OR!.push({ externalAuthId: userId });

    const user = await this.prisma.user.findFirst({ where });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    return user;
  }

  @Post('otp/request')
  async requestOtp(
    @Body() body: RequestOtpDto,
    @Req() req: Request
  ): Promise<{ success: boolean; message: string }> {
    const { email } = body;

    if (!email || typeof email !== 'string') {
      throw new HttpException('Enter your email address', HttpStatus.BAD_REQUEST);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new HttpException('Enter a valid email address', HttpStatus.BAD_REQUEST);
    }

    const ipAddress = this.getClientIp(req);

    await this.turnstile.verifyRequest(req, 'signin', ipAddress);

    const existing = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { isSuperAdmin: true }
    });
    if (!existing?.isSuperAdmin) await this.authz.assertInstanceSsoNotEnforced('otp');

    return this.otpService.requestOtp(email, ipAddress);
  }

  @Post('otp/verify')
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    const { email, code } = body;

    if (!email || typeof email !== 'string') {
      throw new HttpException('Enter your email address', HttpStatus.BAD_REQUEST);
    }

    if (!code || typeof code !== 'string') {
      throw new HttpException('Enter the code', HttpStatus.BAD_REQUEST);
    }

    const ipAddress = this.getClientIp(req);

    await this.turnstile.verifyRequest(req, 'signin', ipAddress);

    const result = await this.otpService.verifyOtp(email, code, ipAddress);

    if (!result.valid || !result.email) {
      throw new HttpException('That code is wrong or expired', HttpStatus.UNAUTHORIZED);
    }

    // Private beta: check access BEFORE creating the user so rejected
    // signups don't leave an orphan user row with zero organizations.
    const normalizedEmail = result.email.toLowerCase().trim();
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    const hasAccess = await this.hasPrivateBetaAccess(normalizedEmail, existingUser);
    if (!hasAccess) {
      throw new HttpException(signupDeniedError(), HttpStatus.FORBIDDEN);
    }

    // H-1: refuse OTP login when the user's org enforces SSO.
    // H-4: even for brand-new identities, refuse OTP if the email has a
    // pending invite from an SSO-enforced org, otherwise an attacker who
    // controls the inbox can slip in before SSO is enforced.
    await this.authz.assertSsoNotEnforced(existingUser, 'otp');
    if (!existingUser) {
      await this.authz.assertSsoNotEnforcedForEmail(normalizedEmail, 'otp');
    }

    const user = existingUser ?? (await this.findOrCreateUserByEmail(result.email));

    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod: 'otp'
    });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'otp',
      sessionId
    );

    setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: signedInUser(user)
    });
  }

  @Get('config')
  async authConfig(): Promise<{
    turnstileSiteKey: string | null;
    ssoEnforced: boolean;
    emailCodes: boolean;
  }> {
    return {
      turnstileSiteKey: this.turnstile.siteKey(),
      ssoEnforced: await this.instanceSettings.isSsoEnforced(),
      emailCodes: this.otpService.canDeliverCodes()
    };
  }

  /**
   * What this address can sign in with, so the form asks for the right thing
   * rather than mailing a code to an instance with no SMTP.
   * GET /auth/methods?email=user@example.com
   */
  @Get('methods')
  async authMethods(
    @Req() req: Request
  ): Promise<{ passkey: boolean; password: boolean; superadmin: boolean }> {
    const email = ((req.query.email as string) || '').toLowerCase().trim();
    if (!email) return { passkey: false, password: false, superadmin: false };

    const [passkey, password, user] = await Promise.all([
      this.passkeyService.userHasPasskeys(email),
      superadminHasPassword(this.prisma, email, !this.otpService.sendsEmail()),
      this.prisma.user.findUnique({ where: { email }, select: { isSuperAdmin: true } })
    ]);
    return { passkey, password, superadmin: Boolean(user?.isSuperAdmin) };
  }

  /**
   * Sign in with the superadmin password, which only exists on instances where
   * someone set one from the host. See ./superadmin-password for why it is not
   * a general password system.
   * POST /auth/password
   */
  @Post('password')
  async signInWithPassword(
    @Body() body: PasswordDto,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    const { email, password } = body || ({} as PasswordDto);
    if (!email || typeof email !== 'string') {
      throw new HttpException('Enter your email address', HttpStatus.BAD_REQUEST);
    }
    if (!password || typeof password !== 'string') {
      throw new HttpException('Enter your password', HttpStatus.BAD_REQUEST);
    }

    const normalizedEmail = email.toLowerCase().trim();
    const ipAddress = this.getClientIp(req);

    await this.rateLimit.checkRateLimit(ipAddress, 'ip', 'password_signin');
    await this.rateLimit.checkRateLimit(normalizedEmail, 'email', 'password_signin');
    await this.turnstile.verifyRequest(req, 'signin', ipAddress);

    const match = await verifySuperadminPassword(
      this.prisma,
      normalizedEmail,
      password,
      !this.otpService.sendsEmail()
    );
    if (!match) {
      throw new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED);
    }

    const user = await this.prisma.user.findUnique({ where: { id: match.id } });
    if (!user) throw new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED);

    if (!(await this.hasPrivateBetaAccess(user.email, user))) {
      throw new HttpException(signupDeniedError(), HttpStatus.FORBIDDEN);
    }

    await this.authz.assertSsoNotEnforced(user, 'password');

    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod: 'password'
    });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'password',
      sessionId
    );

    await this.rateLimit.resetRateLimit(normalizedEmail, 'email', 'password_signin');
    await this.rateLimit.resetRateLimit(ipAddress, 'ip', 'password_signin');

    setSessionCookie(res, token);
    res.status(200).json({
      success: true,
      user: signedInUser(user)
    });
  }

  /**
   * Set your own password, while signed in as the superadmin. Self-service
   * only in the sense that the session already owns the instance: it grants
   * nothing a signed-in superadmin could not do by other means, and it is what
   * lets the setup flow offer a way back in on a box with no TLS for passkeys.
   * POST /auth/password/set
   */
  @Auth()
  @Post('password/set')
  async setOwnPassword(
    @Body() body: { password: string },
    @Req() req: any
  ): Promise<{ success: true }> {
    const user = await this.resolveInternalUser(req.user.sub);
    if (!user.isSuperAdmin && this.otpService.sendsEmail()) {
      throw new HttpException(
        'Only the superadmin has a password on this instance',
        HttpStatus.FORBIDDEN
      );
    }

    try {
      if (user.isSuperAdmin) {
        await setSuperadminPassword(this.prisma, user.email, body?.password ?? '');
      } else {
        await setAccountPassword(this.prisma, user.id, body?.password ?? '');
      }
    } catch (err) {
      if (err instanceof PasswordRefused) {
        throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
      }
      throw err;
    }

    await this.sessionsService.revokeAllSessions(user.id, req['auth']?.sessionId);

    void this.audit.log({
      action: 'user.password.set',
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email
    });

    return { success: true };
  }

  /**
   * Check if a user has passkeys registered (for conditional UI).
   * GET /auth/passkey/check?email=user@example.com
   */
  @Get('passkey/check')
  async checkPasskeys(@Req() req: Request): Promise<{ hasPasskeys: boolean }> {
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

    const options = await this.passkeyService.generateRegistrationOptions(user.id, email);

    return options;
  }

  @Auth()
  @Post('passkey/register/verify')
  async verifyRegistration(@Body() body: RegisterPasskeyDto, @Req() req: any) {
    const email = req.user.email;
    const user = await this.resolveInternalUser(req.user.sub);

    const result = await this.passkeyService.verifyRegistration(
      user.id,
      email,
      body.response,
      body.friendlyName
    );
    await this.sessionsService.revokeAllSessions(user.id, req['auth']?.sessionId);

    return result;
  }

  @Post('passkey/authenticate/options')
  async getAuthenticationOptions(@Body() body: { email?: string }, @Req() req: Request) {
    const ipAddress = this.getClientIp(req);
    const options = await this.passkeyService.generateAuthenticationOptions(body.email, ipAddress);

    return options;
  }

  @Post('passkey/authenticate/verify')
  async verifyAuthentication(
    @Body() body: AuthenticatePasskeyDto,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    const ipAddress = this.getClientIp(req);

    const result = await this.passkeyService.verifyAuthentication(body.response, ipAddress);

    if (!result.verified || !result.userId) {
      throw new HttpException('Authentication failed', HttpStatus.UNAUTHORIZED);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: result.userId }
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    // Private beta: reject users not invited to any organization
    const hasAccess = await this.hasPrivateBetaAccess(user.email, {
      id: user.id,
      isSuperAdmin: user.isSuperAdmin
    });
    if (!hasAccess) {
      throw new HttpException(signupDeniedError(), HttpStatus.FORBIDDEN);
    }

    // H-1: refuse passkey login when the user's org enforces SSO.
    await this.authz.assertSsoNotEnforced(user, 'passkey');

    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod: 'passkey'
    });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'passkey',
      sessionId
    );

    setSessionCookie(res, token);

    res.status(200).json({
      success: true,
      user: signedInUser(user)
    });
  }

  @Auth()
  @Get('passkeys')
  async listPasskeys(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);

    const passkeys = await this.passkeyService.getUserPasskeys(user.id);
    return { passkeys };
  }

  @Auth()
  @Delete('passkeys/:id')
  async deletePasskey(@Param('id') passkeyId: string, @Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);

    await this.passkeyService.deletePasskey(user.id, passkeyId);
    return { success: true };
  }

  @Auth()
  @Post('passkeys/:id/rename')
  async updatePasskey(
    @Param('id') passkeyId: string,
    @Body() body: UpdatePasskeyDto,
    @Req() req: any
  ) {
    const user = await this.resolveInternalUser(req.user.sub);

    await this.passkeyService.updatePasskeyName(user.id, passkeyId, body.friendlyName);

    return { success: true };
  }

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
      req.user.orgScope
    );

    res.status(200).json({ token });
  }

  @Auth()
  @Get('sessions')
  async listSessions(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);
    const sessions = await this.sessionsService.getUserSessions(user.id);

    const currentSessionId = req.user.sessionId;
    return {
      sessions: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === currentSessionId
      }))
    };
  }

  @Auth()
  @Delete('sessions/:id')
  async revokeSession(@Param('id') sessionId: string, @Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);

    // Prevent revoking current session via this endpoint
    if (sessionId === req.user.sessionId) {
      throw new HttpException('Sign out to end your current session', HttpStatus.BAD_REQUEST);
    }

    const revoked = await this.sessionsService.revokeSession(user.id, sessionId);

    if (!revoked) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    }

    return { success: true };
  }

  @Auth()
  @Post('sessions/revoke-all')
  async revokeAllSessions(@Req() req: any) {
    const user = await this.resolveInternalUser(req.user.sub);
    const currentSessionId = req.user.sessionId;

    const count = await this.sessionsService.revokeAllSessions(user.id, currentSessionId);

    return { success: true, revokedCount: count };
  }

  /**
   * Find or create a user by email (for OTP authentication).
   */
  private async findOrCreateUserByEmail(email: string) {
    const normalizedEmail = email.toLowerCase().trim();

    let user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (!user) {
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
          emailVerifiedAt: new Date()
        }
      });
      void this.audit.log({
        action: 'user.signed_up',
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: 'user',
        targetId: user.id,
        metadata: { signup_method: 'otp' }
      });
    }

    // OTP sign-in does not go through findOrCreateByExternalAuthId, so it needs
    // its own hook or email-avatar import would only ever work for OAuth users.
    // Unawaited: never make someone wait on a third-party probe to log in.
    void this.usersService.ensureImageUrl(user).catch(() => {});

    return user;
  }
}
