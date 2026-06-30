import { Controller, Get, Param, Query, Request, BadRequestException } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { ObservabilityService } from './observability.service';

@Auth()
@Controller('observe')
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  @Get('deployments/:id/capabilities')
  async getCapabilities(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.getCapabilities(id);
  }

  @Get('deployments/:id/http-metrics')
  async getHttpMetrics(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string,
  ) {
    await this.assertAccess(id, req);
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(1000, Number(stepStr) || 30_000);
    if (end <= start) throw new BadRequestException('end must be > start');
    return this.observability.getHttpMetrics(id, start, end, step);
  }

  @Get('deployments/:id/logs/structured')
  async getStructuredLogs(
    @Param('id') id: string,
    @Request() req,
    @Query('tailLines') tailLinesStr?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ) {
    await this.assertAccess(id, req);
    const tailLines = Math.min(Math.max(1, Number(tailLinesStr) || 200), 20000);
    return this.observability.getStructuredLogs(id, tailLines, level, search);
  }

  @Get('deployments/:id/overview')
  async getOverview(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.getOverview(id);
  }

  @Get('deployments/:id/runtime')
  async getRuntime(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.detectRuntime(id);
  }

  @Get('deployments/:id/errors')
  async getErrors(
    @Param('id') id: string,
    @Request() req,
    @Query('window') windowStr?: string,
  ) {
    await this.assertAccess(id, req);
    const window = Math.min(Math.max(1, Number(windowStr) || 60), 1440);
    return this.observability.getErrors(id, window);
  }

  private assertAccess(deploymentId: string, req) {
    return this.projectAccess.assertDeploymentView(deploymentId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }
}
