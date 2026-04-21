import { Controller, Get, Patch, Post, Delete, Query, Body, Res, Req, HttpException, HttpStatus, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { OAuthService } from './oauth.service';
import { SessionsService } from './sessions.service';
import { StorageService } from '../organizations/storage.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public, Auth } from './decorators';

@Public()
@Controller('auth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly sessionsService: SessionsService,
    private readonly storageService: StorageService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Check if a user has access to the platform (member of any org or has pending invitations).
   * SuperAdmins always have access.
   */
  private async hasPrivateBetaAccess(userId: string, email: string): Promise<boolean> {
    const dbUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (dbUser?.isSuperAdmin) return true;

    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId },
    });
    if (membership) return true;

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        expiresAt: { gt: new Date() },
      },
    });
    if (invitation) return true;

    return false;
  }

  @Get('login')
  login(@Res() res: Response) {
    const state = Math.random().toString(36).substring(7);
    const authUrl = this.oauthService.getAuthorizationUrl(state);
    return res.redirect(authUrl);
  }

  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    if (Array.isArray(forwarded)) return forwarded[0];
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      throw new HttpException('No authorization code provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const accessToken = await this.oauthService.exchangeCodeForToken(code);
      const hackClubUser = await this.oauthService.getUserInfo(accessToken);

      const user = await this.usersService.findOrCreateByHackClubId(hackClubUser);

      // Private beta: reject users not invited to any organization
      const hasAccess = await this.hasPrivateBetaAccess(user.id, user.email);
      if (!hasAccess) {
        return res.redirect(
          `${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth/callback?error=${encodeURIComponent('private_beta')}`
        );
      }

      const sessionId = await this.sessionsService.createSession({
        userId: user.id,
        ipAddress: this.getClientIp(req),
        userAgent: req.headers['user-agent'],
        authMethod: 'oauth',
      });

      const sessionToken = await this.oauthService.generateSessionToken(hackClubUser, sessionId);

      res.cookie('session_token', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
        domain: process.env.COOKIE_DOMAIN || undefined,
      });

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

    res.clearCookie('session_token', {
      path: '/',
      domain: process.env.COOKIE_DOMAIN || undefined,
    });
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

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      hackClubId: req.user.hackClubId || user.hackClubId,
      isSuperAdmin: user.isSuperAdmin,
      setupCompleted: user.setupCompleted,
    };
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
