import { Controller, Get, Param, UseGuards, Post, Body, Request, Delete } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  @UseGuards(AuthGuard)
  async createWorkspace(
    @Body() body: { organizationId: string; name: string; slug?: string; description?: string },
    @Request() req
  ) {
    const { organizationId, name, slug, description } = body;
    return this.workspacesService.createWorkspace(
      organizationId,
      { name, slug, description },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      }
    );
  }

  @Get()
  @UseGuards(AuthGuard)
  async listWorkspaces(@Request() req) {
    return this.workspacesService.listWorkspaces(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get('roles')
  @UseGuards(AuthGuard)
  async getRoles() {
    return this.workspacesService.getRoles();
  }

  @Get('slug/:slug')
  @UseGuards(AuthGuard)
  async getWorkspaceBySlug(@Param('slug') slug: string) {
    return this.workspacesService.getWorkspaceBySlug(slug);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  async getWorkspace(@Param('id') id: string) {
    return this.workspacesService.getWorkspace(id);
  }

  @Get(':id/projects')
  @UseGuards(AuthGuard)
  async getWorkspaceProjects(@Param('id') id: string) {
    return this.workspacesService.getWorkspaceProjects(id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async deleteWorkspace(@Param('id') id: string, @Request() req) {
    return this.workspacesService.deleteWorkspace(id, req.user.sub);
  }

  @Post(':id/members')
  @UseGuards(AuthGuard)
  async addMemberToWorkspace(
    @Param('id') workspaceId: string,
    @Body('userId') userId: string,
    @Body('roleId') roleId: string,
    @Request() req
  ) {
    return this.workspacesService.addMemberToWorkspace(
      workspaceId,
      userId,
      roleId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      }
    );
  }

  @Post(':id/invite')
  @UseGuards(AuthGuard)
  async inviteMemberToWorkspace(
    @Param('id') workspaceId: string,
    @Body('userId') userId: string,
    @Body('roleId') roleId: string,
    @Request() req
  ) {
    return this.workspacesService.inviteMemberToWorkspace(
      workspaceId,
      userId,
      roleId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      }
    );
  }

  @Post(':id/join')
  @UseGuards(AuthGuard)
  async joinWorkspace(
    @Param('id') workspaceId: string,
    @Request() req
  ) {
    return this.workspacesService.joinWorkspace(
      workspaceId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      }
    );
  }

  @Post(':id/leave')
  @UseGuards(AuthGuard)
  async leaveWorkspace(
    @Param('id') workspaceId: string,
    @Request() req
  ) {
    return this.workspacesService.leaveWorkspace(
      workspaceId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      }
    );
  }
}
