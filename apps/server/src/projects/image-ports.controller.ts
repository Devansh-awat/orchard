import { Controller, Get, Param, Query, Request } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from './project-access.service';
import { RegistryCredentialsService } from './registry-credentials.service';

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
@Controller()
export class ImagePortsController {
  constructor(
    private readonly credentials: RegistryCredentialsService,
    private readonly projectAccess: ProjectAccessService
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('projects/:projectId/image-ports')
  async forProject(
    @Param('projectId') projectId: string,
    @Query('image') image: unknown,
    @Request() req
  ) {
    await this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      'detect image ports'
    );
    return this.credentials.detectImagePorts(image, { projectId });
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('organizations/:organizationId/image-ports')
  async forOrganization(
    @Param('organizationId') organizationId: string,
    @Query('image') image: unknown,
    @Request() req
  ) {
    await this.projectAccess.assertOrgCanCreateProjects(
      organizationId,
      req.user.sub,
      userData(req)
    );
    return this.credentials.detectImagePorts(image, { organizationId });
  }
}
