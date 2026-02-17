import { Controller, Get, Patch, Query, Body, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { OAuthService } from './oauth.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('auth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
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

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') error: string,
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

      const sessionToken = await this.oauthService.generateSessionToken(hackClubUser);

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
  logout(@Res() res: Response) {
    res.clearCookie('session_token', {
      path: '/',
      domain: process.env.COOKIE_DOMAIN || undefined,
    });
    return res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  }

  @Get('me')
  async me(@Req() req: any) {
    const token = req.cookies?.session_token;

    if (!token) {
      throw new HttpException('Not authenticated', HttpStatus.UNAUTHORIZED);
    }

    try {
      const payload = await this.oauthService.verifySessionToken(token);
      
      let user;
      if (payload.authMethod === 'oauth' && payload.hackClubId) {
        user = await this.usersService.findOrCreateByHackClubId({
          id: payload.hackClubId,
          email: payload.email,
          name: payload.name,
        });
      } else {
        user = await this.usersService.findByIdOrHackClubId(payload.sub);
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
        hackClubId: payload.hackClubId || user.hackClubId,
        isSuperAdmin: user.isSuperAdmin,
      };
    } catch (err) {
      throw new HttpException('Invalid session', HttpStatus.UNAUTHORIZED);
    }
  }

  @Patch('me')
  async updateMe(
    @Req() req: any,
    @Body() body: { firstName?: string; lastName?: string; username?: string },
  ) {
    const token = req.cookies?.session_token;

    if (!token) {
      throw new HttpException('Not authenticated', HttpStatus.UNAUTHORIZED);
    }

    try {
      const payload = await this.oauthService.verifySessionToken(token);

      let user;
      if (payload.authMethod === 'oauth' && payload.hackClubId) {
        user = await this.usersService.findOrCreateByHackClubId({
          id: payload.hackClubId,
          email: payload.email,
          name: payload.name,
        });
      } else {
        user = await this.usersService.findByIdOrHackClubId(payload.sub);
        if (!user) {
          throw new HttpException('User not found', HttpStatus.NOT_FOUND);
        }
      }

      const updatedUser = await this.usersService.updateProfile(user.id, {
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
      });

      return updatedUser;
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Handle specific error messages
      if (err instanceof Error && err.message === 'Username is already taken') {
        throw new HttpException('Username is already taken', HttpStatus.CONFLICT);
      }
      throw new HttpException('Failed to update profile', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
