import { Controller, Get, Post, Body, Request, Response, BadRequestException } from '@nestjs/common';
import { Response as ExpressResponse } from 'express';
import { Public, Auth } from '../auth/decorators';
import { SessionsService } from '../auth/sessions.service';
import { OAuthService } from '../auth/oauth.service';
import { setSessionCookie } from '../auth/cookies';
import { SetupService } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly sessions: SessionsService,
    private readonly oauth: OAuthService,
  ) {}

  @Public()
  @Get('status')
  status() {
    return this.setup.getStatus();
  }

  @Auth()
  @Post('claim')
  claim(@Request() req, @Body() body: { token?: string }) {
    return this.setup.claim(req.user.sub, body?.token ?? '');
  }

  /**
   * Claim and sign in in one step, for an instance that has no way to deliver
   * an OTP yet. The token comes from the server log or `orchard-claim` on the
   * host, so this is only reachable by whoever already runs the box.
   */
  @Public()
  @Post('bootstrap')
  async bootstrap(
    @Body() body: { token?: string; email?: string },
    @Request() req,
    @Response() res: ExpressResponse,
  ): Promise<void> {
    const email = (body?.email || process.env.SETUP_ADMIN_EMAIL || '').trim();
    if (!email) throw new BadRequestException('An email address is required to claim this instance');

    const user = await this.setup.bootstrap(body?.token ?? '', email);

    const sessionId = await this.sessions.createSession({
      userId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      authMethod: 'setup_claim',
    });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const token = await this.oauth.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'setup_claim',
      sessionId,
    );

    setSessionCookie(res, token);
    res.status(200).json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
  }
}
