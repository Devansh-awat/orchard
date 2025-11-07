import { Controller, Get, Post, Param, UseGuards, Request } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  // Protected endpoint - get pending invitations for the logged-in user
  @Get('pending')
  @UseGuards(AuthGuard)
  async getPendingInvitations(@Request() req) {
    return this.organizationsService.getPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  // Protected endpoint - accept all pending invitations for the logged-in user
  @Post('accept-pending')
  @UseGuards(AuthGuard)
  async acceptPendingInvitations(@Request() req) {
    return this.organizationsService.acceptPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  // Public endpoint - get invitation details by token (no auth required)
  @Get(':token')
  async getInvitationByToken(@Param('token') token: string) {
    return this.organizationsService.getInvitationByToken(token);
  }

  // Protected endpoint - accept invitation (requires auth)
  @Post(':token/accept')
  @UseGuards(AuthGuard)
  async acceptInvitation(@Param('token') token: string, @Request() req) {
    return this.organizationsService.acceptInvitationByToken(token, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  // Protected endpoint - decline invitation (requires auth)
  @Post(':token/decline')
  @UseGuards(AuthGuard)
  async declineInvitation(@Param('token') token: string, @Request() req) {
    return this.organizationsService.declineInvitationByToken(token, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }
}
