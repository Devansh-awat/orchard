import { Controller, Get, Param, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { AnomaliesService } from './anomalies.service';

function who(req: any) {
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
export class AnomaliesController {
  constructor(
    private readonly anomalies: AnomaliesService,
    private readonly access: ProjectAccessService
  ) {}

  @Get('projects/:id/anomalies')
  async forProject(@Param('id') id: string, @Request() req) {
    await this.access.assertProjectView(id, req.user.sub, who(req));
    return { anomalies: await this.anomalies.forProject(id) };
  }

  @Get('deployments/:id/anomalies')
  async forDeployment(@Param('id') id: string, @Request() req) {
    await this.access.assertDeploymentView(id, req.user.sub, who(req));
    return { anomalies: await this.anomalies.forDeployment(id) };
  }

  @Get('databases/:id/anomalies')
  async forDatabase(@Param('id') id: string, @Request() req) {
    await this.access.assertDatabaseView(id, req.user.sub, who(req));
    return { anomalies: await this.anomalies.forDatabase(id) };
  }
}
