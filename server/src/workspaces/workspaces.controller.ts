import { Controller, Get, Param, Post, Body, Request, Delete, Query } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()

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

  async getRoles() {
    return this.workspacesService.getRoles();
  }

  @Get('slug/:slug')

  async getWorkspaceBySlug(@Param('slug') slug: string) {
    return this.workspacesService.getWorkspaceBySlug(slug);
  }

  @Get(':id')

  async getWorkspace(@Param('id') id: string) {
    return this.workspacesService.getWorkspace(id);
  }

  @Get(':id/projects')

  async getWorkspaceProjects(@Param('id') id: string) {
    return this.workspacesService.getWorkspaceProjects(id);
  }

  @Delete(':id')

  async deleteWorkspace(@Param('id') id: string, @Query('force') force: string, @Request() req) {
    return this.workspacesService.deleteWorkspace(id, req.user.sub, force === 'true');
  }

  @Post(':id/members')

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
