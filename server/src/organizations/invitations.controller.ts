import { Controller, Get, Post, Param, Request } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { Public, Auth } from '../auth/decorators';

@Auth()
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('pending')
  async getPendingInvitations(@Request() req) {
    return this.organizationsService.getPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post('accept-pending')
  async acceptPendingInvitations(@Request() req) {
    return this.organizationsService.acceptPendingInvitationsForUser(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Public()
  @Get(':token')
  async getInvitationByToken(@Param('token') token: string) {
    return this.organizationsService.getInvitationByToken(token);
  }

  @Post(':token/accept')
  async acceptInvitation(@Param('token') token: string, @Request() req) {
    return this.organizationsService.acceptInvitationByToken(token, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post(':token/decline')
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
