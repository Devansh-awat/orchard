import { stepUp } from './step-up';
import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Query,
  Body,
  Res,
  Req,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile
} from '@nestjs/common';
import { AVATAR_UPLOAD_BYTES, ImageUploadSlots, uploadLimits } from '../http/upload-limits';
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
import { signupMode, signupDeniedError } from './signup-mode';
import { accountEmail } from '../users/account-scope';

@Public()
@Controller('auth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly sessionsService: SessionsService,
    private readonly storageService: StorageService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService
  ) {}

  /**
   * Check if a user has access to the platform (member of any org or has pending invitations).
   * SuperAdmins always have access.
   */
  private async hasPrivateBetaAccess(
    email: string | null,
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

    if (signupMode() === 'closed' || !email) return false;

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        expiresAt: { gt: new Date() }
      }
    });
    return !!invitation;
  }

  @Get('login')
  async login(@Res() res: Response) {
    if (!this.oauthService.oauthEnabled) {
      const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendBase}?error=${encodeURIComponent('oauth_disabled')}`);
    }
    const state = crypto.randomBytes(32).toString('hex');
    const cookie = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 10 * 60 * 1000,
      path: '/apiv1/auth'
    };
    res.cookie('oauth_state', state, cookie);
    let challenge: string | undefined;
    if (await this.oauthService.usesPkce()) {
      const verifier = crypto.randomBytes(32).toString('base64url');
      challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      res.cookie('oauth_pkce', verifier, cookie);
    }
    const authUrl = await this.oauthService.getAuthorizationUrl(state, challenge);
    return res.redirect(authUrl);
  }

  private clearOauthStateCookie(res: Response) {
    res.clearCookie('oauth_state', { path: '/apiv1/auth' });
    res.clearCookie('oauth_pkce', { path: '/apiv1/auth' });
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
    @Res() res: Response
  ) {
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (error) {
      this.clearOauthStateCookie(res);
      return res.redirect(`${frontendBase}?error=${encodeURIComponent(error)}`);
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
        `${frontendBase}/oauth/callback?error=${encodeURIComponent('invalid_state')}`
      );
    }
    const codeVerifier = (req as any).cookies?.oauth_pkce as string | undefined;
    this.clearOauthStateCookie(res);

    try {
      const accessToken = await this.oauthService.exchangeCodeForToken(code, codeVerifier);
      const hackClubUser = await this.oauthService.getUserInfo(accessToken);

      let existingUser = await this.prisma.user.findUnique({
        where: { externalAuthId: hackClubUser.id }
      });

      if (!existingUser) {
        const emailOwner = await this.prisma.user.findUnique({
          where: accountEmail(hackClubUser.email)
        });
        if (emailOwner) {
          if (
            !hackClubUser.emailVerified ||
            (emailOwner.externalAuthId && emailOwner.externalAuthId !== hackClubUser.id)
          ) {
            // Existing account is already linked to a different Hack Club
            // identity: refuse with a generic error to avoid an enumeration
            // oracle.
            return res.redirect(
              `${frontendBase}/oauth/callback?error=${encodeURIComponent('oauth_failed')}`
            );
          }
          // Email row exists but isn't linked to a Hack Club identity yet
          // (typically an OTP-registered user). Treat it as the existing
          // user for downstream SSO / private-beta checks; the actual link
          // happens in findOrCreateByExternalAuthId below.
          existingUser = emailOwner;
        }
      }

      // H-1: if the user is in any org with SSO enforced, OAuth/OTP/passkey
      // are not valid login paths: they must come through the SSO callback.
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
          `${frontendBase}/oauth/callback?error=${encodeURIComponent('sso_required')}`
        );
      }

      const hasAccess = await this.hasPrivateBetaAccess(
        hackClubUser.emailVerified ? hackClubUser.email : null,
        existingUser
      );
      if (!hasAccess) {
        return res.redirect(
          `${frontendBase}/oauth/callback?error=${encodeURIComponent(signupDeniedError())}`
        );
      }

      const user = await this.usersService.findOrCreateByExternalAuthId(hackClubUser);

      const sessionId = await this.sessionsService.createSession({
        userId: user.id,
        ipAddress: this.getClientIp(req),
        userAgent: req.headers['user-agent'],
        authMethod: 'oauth'
      });

      const sessionToken = await this.oauthService.generateSessionToken(hackClubUser, sessionId);

      setSessionCookie(res, sessionToken);

      return res.redirect(`${frontendBase}/oauth/callback`);
    } catch (err) {
      console.error('OAuth callback error:', err);
      return res.redirect(`${frontendBase}?error=${encodeURIComponent('Authentication failed')}`);
    }
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    // Try to revoke the session if there's a valid token
    try {
      const token = req.cookies?.session_token;
      if (token) {
        const oauthService = this.oauthService;
        const payload = await oauthService.verifySessionSignature(token);
        if (payload.sessionId) {
          let userId = payload.sub;
          if (payload.externalAuthId) {
            const dbUser = await this.prisma.user.findUnique({
              where: { externalAuthId: payload.externalAuthId },
              select: { id: true }
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
    // sameSite/domain attributes stay in lockstep with setSessionCookie. A clear
    // that passes only { path, domain } leaves browsers free to refuse it when the
    // original cookie had SameSite=Strict from a cross-site context (rare, but
    // observed).
    clearSessionCookie(res);
    return res.status(204).send();
  }

  @Auth()
  @Get('me')
  async me(@Req() req: any) {
    const userId = req.user.sub;

    let user;
    if (req.user.externalAuthId) {
      user = await this.usersService.findByExternalAuthId(req.user.externalAuthId);
      if (!user) {
        user = await this.usersService.findOrCreateByExternalAuthId({
          id: req.user.externalAuthId,
          email: req.user.email,
          name: req.user.name
        });
      }
    } else {
      user = await this.usersService.findByIdOrExternalAuthId(userId);
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
      externalAuthId: req.user.externalAuthId || user.externalAuthId,
      hackClubId: req.user.externalAuthId || user.externalAuthId,
      setupCompleted: user.setupCompleted,
      seenUpdates: user.seenUpdates ?? [],
      ...(user.homeOrganizationId ? { homeOrganizationId: user.homeOrganizationId } : {}),
      ...(req.user.orgScope ? { sessionOrganizationId: req.user.orgScope } : {}),
      ...(user.passkeyOnly ? { passkeyOnly: true } : {}),
      ...(await this.sessionGrants(req.user.sessionId, req.user.orgScope)),
      ...(!user.homeOrganizationId && !req.user.orgScope
        ? await this.emailDomainOwner(user.email)
        : {})
    };
    return user.isSuperAdmin ? { ...base, isSuperAdmin: true } : base;
  }

  private async sessionGrants(sessionId: string | undefined, orgScope: string | undefined) {
    if (!sessionId || orgScope) return {};
    const grants = await this.prisma.sessionOrgGrant.findMany({
      where: { sessionId, expiresAt: { gt: new Date() } },
      select: {
        organizationId: true,
        expiresAt: true,
        organization: { select: { name: true, slug: true } }
      }
    });
    if (!grants.length) return {};
    return {
      ssoGrants: grants.map((g) => ({
        organizationId: g.organizationId,
        name: g.organization.name,
        slug: g.organization.slug,
        expiresAt: g.expiresAt
      }))
    };
  }

  private async emailDomainOwner(email: string) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return {};
    const owner = await this.prisma.orgDomain.findFirst({
      where: { domain, verifiedAt: { not: null } },
      select: { organization: { select: { name: true } } }
    });
    return owner ? { emailDomainOwner: { domain, organization: owner.organization.name } } : {};
  }

  @Auth()
  @Post('me/seen-updates')
  async markUpdateSeen(@Req() req: any, @Body() body: { id?: string }) {
    if (!body?.id) {
      throw new HttpException('id is required', HttpStatus.BAD_REQUEST);
    }
    const user = await this.resolveUser(req);
    return this.usersService.markUpdateSeen(user.id, body.id);
  }

  @Auth()
  @Patch('me')
  async updateMe(
    @Req() req: any,
    @Body() body: {
      firstName?: string | null;
      lastName?: string | null;
      username?: string;
      setupCompleted?: boolean;
      passkeyOnly?: boolean;
    }
  ) {
    const userId = req.user.sub;

    let user;
    if (req.user.externalAuthId) {
      user = await this.usersService.findByExternalAuthId(req.user.externalAuthId);
      if (!user) {
        user = await this.usersService.findOrCreateByExternalAuthId({
          id: req.user.externalAuthId,
          email: req.user.email,
          name: req.user.name
        });
      }
    } else {
      user = await this.usersService.findByIdOrExternalAuthId(userId);
      if (!user) {
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }
    }

    if (body.passkeyOnly === false && user.passkeyOnly) {
      const refusal = await stepUp(this.prisma, {
        action: 'turn email codes back on',
        user: { id: user.id, passwordHash: null },
        auth: req['auth']
      });
      if (refusal) throw new HttpException(refusal, HttpStatus.FORBIDDEN);
    }

    try {
      const updatedUser = await this.usersService.updateProfile(user.id, {
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        setupCompleted: body.setupCompleted,
        ...(typeof body.passkeyOnly === 'boolean' ? { passkeyOnly: body.passkeyOnly } : {})
      });

      return updatedUser;
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      if (err instanceof Error && err.message === 'Username is already taken') {
        throw new HttpException('Username is already taken', HttpStatus.CONFLICT);
      }
      throw new HttpException("Couldn't update your profile", HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async resolveUser(req: any) {
    if (req.user.externalAuthId) {
      const user = await this.usersService.findByExternalAuthId(req.user.externalAuthId);
      if (user) return user;
      return this.usersService.findOrCreateByExternalAuthId({
        id: req.user.externalAuthId,
        email: req.user.email,
        name: req.user.name
      });
    }
    const user = await this.usersService.findByIdOrExternalAuthId(req.user.sub);
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    return user;
  }

  @Auth()
  @Post('me/avatar')
  @UseInterceptors(ImageUploadSlots, FileInterceptor('file', uploadLimits(AVATAR_UPLOAD_BYTES)))
  async uploadAvatar(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) {
      throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new HttpException('Use a JPEG, PNG, GIF or WebP image', HttpStatus.BAD_REQUEST);
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new HttpException('Use a file under 5 MB', HttpStatus.BAD_REQUEST);
    }

    const user = await this.resolveUser(req);

    const imageUrl = await this.storageService.uploadImage(file, `users/${user.id}`);

    if (user.imageUrl) {
      await this.storageService
        .deleteReplaced(user.imageUrl, `users/${user.id}`, {
          model: 'user',
          id: user.id,
          column: 'imageUrl'
        })
        .catch(() => {});
    }

    const updatedUser = await this.usersService.updateProfile(user.id, {
      imageUrl,
      imageSource: 'upload'
    });
    return updatedUser;
  }

  @Auth()
  @Delete('me/avatar')
  async deleteAvatar(@Req() req: any) {
    const user = await this.resolveUser(req);

    if (user.imageUrl) {
      await this.storageService
        .deleteReplaced(user.imageUrl, `users/${user.id}`, {
          model: 'user',
          id: user.id,
          column: 'imageUrl'
        })
        .catch(() => {});
    }

    // 'none' is a standing opt-out: without it the next sign-in would just
    // re-import the Gravatar they only now finished deleting.
    const updatedUser = await this.usersService.updateProfile(user.id, {
      imageUrl: null,
      imageSource: 'none'
    });
    return updatedUser;
  }
}
