import { Controller, Get, Patch, Post, Delete, Query, Body, Res, Req, HttpException, HttpStatus, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { OAuthService } from './oauth.service';
import { SessionsService } from './sessions.service';
import { StorageService } from '../organizations/storage.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';
import { setSessionCookie, clearSessionCookie } from './cookies';
import { Public, Auth } from './decorators';
import { getClientIp } from './client-ip';

@Public()
@Controller('auth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly sessionsService: SessionsService,
    private readonly storageService: StorageService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
  ) {}

  /**
   * Check if a user has access to the platform (member of any org or has pending invitations).
   * SuperAdmins always have access.
   */
  private async hasPrivateBetaAccess(
    email: string,
    existingUser: { id: string; isSuperAdmin: boolean } | null,
  ): Promise<boolean> {
    if (existingUser?.isSuperAdmin) return true;

    if (existingUser) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId: existingUser.id },
      });
      if (membership) return true;
    }

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        expiresAt: { gt: new Date() },
      },
    });
    return !!invitation;
  }

  @Get('login')
  login(@Res() res: Response) {
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/apiv1/auth',
    });
    const authUrl = this.oauthService.getAuthorizationUrl(state);
    return res.redirect(authUrl);
  }

  private clearOauthStateCookie(res: Response) {
    res.clearCookie('oauth_state', { path: '/apiv1/auth' });
  }

  private getClientIp(req: Request): string {
    return getClientIp(req);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (error) {
      this.clearOauthStateCookie(res);
      return res.redirect(`${process.env.FRONTEND_URL}?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      throw new HttpException('No authorization code provided', HttpStatus.BAD_REQUEST);
    }

    // CSRF: validate state against httpOnly cookie set in /login.
    const cookieState = (req as any).cookies?.oauth_state;
    const stateMismatch = (() => {
      if (!state || !cookieState) return true;
      const a = Buffer.from(state, 'utf8');
      const b = Buffer.from(cookieState, 'utf8');
      if (a.length !== b.length) return true;
      try {
        return !crypto.timingSafeEqual(a, b);
      } catch {
        return true;
      }
    })();
    if (stateMismatch) {
      this.clearOauthStateCookie(res);
      return res.redirect(
        `${frontendBase}/oauth/callback?error=${encodeURIComponent('invalid_state')}`,
      );
    }
    this.clearOauthStateCookie(res);

    try {
      const accessToken = await this.oauthService.exchangeCodeForToken(code);
      const hackClubUser = await this.oauthService.getUserInfo(accessToken);

      let existingUser = await this.prisma.user.findUnique({
        where: { hackClubId: hackClubUser.id },
      });

      if (!existingUser) {
        const emailOwner = await this.prisma.user.findUnique({
          where: { email: hackClubUser.email },
        });
        if (emailOwner) {
          if (emailOwner.hackClubId && emailOwner.hackClubId !== hackClubUser.id) {
            // Existing account is already linked to a different Hack Club
            // identity — refuse with a generic error to avoid an enumeration
            // oracle.
            return res.redirect(
              `${frontendBase}/oauth/callback?error=${encodeURIComponent('oauth_failed')}`,
            );
          }
          // Email row exists but isn't linked to a Hack Club identity yet
          // (typically an OTP-registered user). Treat it as the existing
          // user for downstream SSO / private-beta checks; the actual link
          // happens in findOrCreateByHackClubId below.
          existingUser = emailOwner;
        }
      }

      // H-1: if the user is in any org with SSO enforced, OAuth/OTP/passkey
      // are not valid login paths — they must come through the SSO callback.
      // H-4: even for brand-new identities, refuse OAuth if the email has a
      // pending invite from an SSO-enforced org. Otherwise an attacker who
      // controls a Hack Club account with the invited email can slip in
      // before SSO is enforced.
      try {
        if (existingUser) {
          await this.authz.assertSsoNotEnforced(existingUser, 'oauth');
        } else {
          await this.authz.assertSsoNotEnforcedForEmail(hackClubUser.email, 'oauth');
        }
      } catch {
        return res.redirect(
          `${frontendBase}/oauth/callback?error=${encodeURIComponent('sso_required')}`,
        );
      }

      const hasAccess = await this.hasPrivateBetaAccess(
        hackClubUser.email,
        existingUser,
      );
      if (!hasAccess) {
        return res.redirect(
          `${frontendBase}/oauth/callback?error=${encodeURIComponent('private_beta')}`
        );
      }

      const user = await this.usersService.findOrCreateByHackClubId(hackClubUser);

      const sessionId = await this.sessionsService.createSession({
        userId: user.id,
        ipAddress: this.getClientIp(req),
        userAgent: req.headers['user-agent'],
        authMethod: 'oauth',
      });

      const sessionToken = await this.oauthService.generateSessionToken(hackClubUser, sessionId);

      setSessionCookie(res, sessionToken);

      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth/callback`);
    } catch (err) {
      console.error('OAuth callback error:', err);
      return res.redirect(
        `${process.env.FRONTEND_URL}?error=${encodeURIComponent('Authentication failed')}`
      );
    }
  }

  @Get('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    // Try to revoke the session if there's a valid token
    try {
      const token = req.cookies?.session_token;
      if (token) {
        const oauthService = this.oauthService;
        const payload = await oauthService.verifySessionToken(token);
        if (payload.sessionId) {
          // Resolve user ID
          let userId = payload.sub;
          if (payload.hackClubId) {
            const dbUser = await this.prisma.user.findUnique({
              where: { hackClubId: payload.hackClubId },
              select: { id: true },
            });
            if (dbUser) userId = dbUser.id;
          }
          await this.sessionsService.revokeSession(userId, payload.sessionId);
        }
      }
    } catch {
      // Best-effort session revocation
    }

    // M-3: route every clear through the cookies helper so secure/httpOnly/
    // sameSite/domain attributes stay in lockstep with setSessionCookie.
    // Prior to this, the clear path passed only { path, domain } which left
    // browsers free to refuse the clear when the original cookie had
    // SameSite=Strict from a cross-site context (rare, but observed).
    clearSessionCookie(res);
    return res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  }

  @Auth()
  @Get('me')
  async me(@Req() req: any) {
    const userId = req.user.sub;

    let user;
    if (req.user.hackClubId) {
      user = await this.usersService.findByHackClubId(req.user.hackClubId);
      if (!user) {
        user = await this.usersService.findOrCreateByHackClubId({
          id: req.user.hackClubId,
          email: req.user.email,
          name: req.user.name,
        });
      }
    } else {
      user = await this.usersService.findByIdOrHackClubId(userId);
      if (!user) {
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }
    }

    // Only emit isSuperAdmin when truthy. Returning the field for every user
    // turns /auth/me into an oracle that confirms "you are not a superadmin",
    // and ships a privilege flag the UI doesn't need for non-admins.
    const base = {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      hackClubId: req.user.hackClubId || user.hackClubId,
      setupCompleted: user.setupCompleted,
    };
    return user.isSuperAdmin ? { ...base, isSuperAdmin: true } : base;
  }

  @Auth()
  @Patch('me')
  async updateMe(
    @Req() req: any,
    @Body() body: { firstName?: string | null; lastName?: string | null; username?: string; setupCompleted?: boolean },
  ) {
    const userId = req.user.sub;

    let user;
    if (req.user.hackClubId) {
      user = await this.usersService.findByHackClubId(req.user.hackClubId);
      if (!user) {
        user = await this.usersService.findOrCreateByHackClubId({
          id: req.user.hackClubId,
          email: req.user.email,
          name: req.user.name,
        });
      }
    } else {
      user = await this.usersService.findByIdOrHackClubId(userId);
      if (!user) {
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }
    }

    try {
      const updatedUser = await this.usersService.updateProfile(user.id, {
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        setupCompleted: body.setupCompleted,
      });

      return updatedUser;
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      if (err instanceof Error && err.message === 'Username is already taken') {
        throw new HttpException('Username is already taken', HttpStatus.CONFLICT);
      }
      throw new HttpException('Failed to update profile', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async resolveUser(req: any) {
    if (req.user.hackClubId) {
      const user = await this.usersService.findByHackClubId(req.user.hackClubId);
      if (user) return user;
      return this.usersService.findOrCreateByHackClubId({
        id: req.user.hackClubId,
        email: req.user.email,
        name: req.user.name,
      });
    }
    const user = await this.usersService.findByIdOrHackClubId(req.user.sub);
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    return user;
  }

  @Auth()
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new HttpException('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed', HttpStatus.BAD_REQUEST);
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new HttpException('File size exceeds 5MB limit', HttpStatus.BAD_REQUEST);
    }

    const user = await this.resolveUser(req);

    const imageUrl = await this.storageService.uploadFile(file, 'users');

    if (user.imageUrl) {
      await this.storageService.deleteFile(user.imageUrl).catch(() => {});
    }

    const updatedUser = await this.usersService.updateProfile(user.id, { imageUrl });
    return updatedUser;
  }

  @Auth()
  @Delete('me/avatar')
  async deleteAvatar(@Req() req: any) {
    const user = await this.resolveUser(req);

    if (user.imageUrl) {
      await this.storageService.deleteFile(user.imageUrl).catch(() => {});
    }

    const updatedUser = await this.usersService.updateProfile(user.id, { imageUrl: null });
    return updatedUser;
  }
}
