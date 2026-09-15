import { Controller, Get, Post, Param, Request } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { Auth } from '../auth/decorators';

/**
 * The recipient half of an ownership handshake. Opening and canceling a
 * request happen on the project (`/projects/:id/transfer-request`), because
 * they need project permissions; answering one happens here, because the only
 * thing that authorizes it is being the person it was addressed to.
 */
@Auth()
@Controller('project-transfers')
export class ProjectTransfersController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async listIncoming(@Request() req) {
    return this.projectsService.listIncomingProjectTransfers(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/accept')
  async accept(@Param('id') id: string, @Request() req) {
    return this.projectsService.acceptProjectTransfer(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/decline')
  async decline(@Param('id') id: string, @Request() req) {
    return this.projectsService.declineProjectTransfer(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }
}
