import { Body, Controller, Get, Post, Param, Request, Response } from '@nestjs/common';
import { Response as ExpressResponse } from 'express';
import { OrganizationsService } from './organizations.service';
import { Public, Auth } from '../auth/decorators';
import { OAuthService } from '../auth/oauth.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { SessionsService } from '../auth/sessions.service';
import { signedInUser } from '../auth/signed-in-user';
import { setSessionCookie } from '../auth/cookies';
import { getClientIp } from '../auth/client-ip';

@Auth()
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly rateLimit: RateLimitService,
    private readonly sessions: SessionsService,
    private readonly oauth: OAuthService
  ) {}

  @Get('pending')
  async getPendingInvitations(@Request() req) {
    return this.organizationsService.getPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post('accept-pending')
  async acceptPendingInvitations(@Request() req) {
    return this.organizationsService.acceptPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  // H-2: in-app accept by row id. The listing endpoints do not return
  // plaintext tokens (they're nulled at rest), so the in-app Accept button
  // calls this route. Every per-token security check still runs under the
  // caller's session inside acceptInvitationById.
  @Post('by-id/:id/accept')
  async acceptInvitationById(@Param('id') id: string, @Request() req) {
    return this.organizationsService.acceptInvitationById(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post('by-id/:id/decline')
  async declineInvitationById(@Param('id') id: string, @Request() req) {
    return this.organizationsService.declineInvitationById(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Public()
  @Get(':token')
  async getInvitationByToken(@Param('token') token: string) {
    return this.organizationsService.getInvitationByToken(token);
  }

  @Public()
  @Post(':token/sign-up')
  async signUp(
    @Param('token') token: string,
    @Body() body: { password?: string; passkey?: boolean },
    @Request() req,
    @Response({ passthrough: true }) res: ExpressResponse
  ) {
    const ipAddress = getClientIp(req);
    await this.rateLimit.checkRateLimit(ipAddress, 'ip', 'password_signin');
    const password = body?.passkey === true ? null : String(body?.password ?? '');
    const { user, organization } = await this.organizationsService.signUpWithInvitation(
      token,
      password
    );
    const authMethod = password === null ? 'passkey' : 'password';
    const sessionId = await this.sessions.createSession({
      userId: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
      authMethod
    });
    const session = await this.oauth.generateSessionTokenForUser(
      user.id,
      user.email,
      user.username,
      authMethod,
      sessionId
    );
    setSessionCookie(res, session);
    return { success: true, user: signedInUser(user), organization };
  }

  @Post(':token/accept')
  async acceptInvitation(@Param('token') token: string, @Request() req) {
    return this.organizationsService.acceptInvitationByToken(token, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':token/decline')
  async declineInvitation(@Param('token') token: string, @Request() req) {
    return this.organizationsService.declineInvitationByToken(token, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }
}
