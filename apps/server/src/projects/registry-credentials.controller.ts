import { Body, Controller, Delete, Get, Param, Put, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from './project-access.service';
import {
  RegistryCredentialInput,
  RegistryCredentialsService
} from './registry-credentials.service';

function userData(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl
  };
}

@Auth()
@Controller('projects/:projectId/registry-credentials')
export class RegistryCredentialsController {
  constructor(
    private readonly credentials: RegistryCredentialsService,
    private readonly projectAccess: ProjectAccessService
  ) {}

  @Get()
  async list(@Param('projectId') projectId: string, @Request() req) {
    await this.projectAccess.assertProjectView(projectId, req.user.sub, userData(req));
    return this.credentials.list(projectId);
  }

  @Put()
  async upsert(
    @Param('projectId') projectId: string,
    @Body() body: RegistryCredentialInput,
    @Request() req
  ) {
    const { user } = await this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      'manage registry credentials'
    );
    return this.credentials.upsert(projectId, body ?? ({} as RegistryCredentialInput), user.id);
  }

  @Delete(':id')
  async remove(@Param('projectId') projectId: string, @Param('id') id: string, @Request() req) {
    const { user } = await this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      'manage registry credentials'
    );
    return this.credentials.remove(projectId, id, user.id);
  }
}
