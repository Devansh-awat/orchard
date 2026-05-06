import { Controller, Get, Param, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectsService } from './projects.service';

@Auth()
@Controller('overview')
export class OverviewController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get('orgs/:orgSlug')
  async getOrgOverview(@Param('orgSlug') orgSlug: string, @Request() req) {
    return this.projectsService.getOrgOverviewBySlug(req.user.sub, orgSlug);
  }
}
