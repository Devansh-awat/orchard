import { Controller, Get, Param, Post, Body, Request, Delete, Put, Patch, Query, Res, HttpStatus, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectsService } from './projects.service';
import { FaviconService } from './favicon.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { StorageService } from '../organizations/storage.service';
import { Auth } from '../auth/decorators';
import { MetricsService } from '../metrics/metrics.service';

@Auth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly storageService: StorageService,
  ) {}

  @Get()

  async listProjects(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listProjects(req.user.sub, orgId);
  }

  @Get('slug/:slug')

  async getProjectBySlug(@Param('slug') slug: string, @Query('orgId') orgId: string, @Request() req) {
    return this.projectsService.getProjectBySlug(orgId, slug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get('by-slugs/:orgSlug/:projectSlug')
  async getProjectBySlugsFull(
    @Param('orgSlug') orgSlug: string,
    @Param('projectSlug') projectSlug: string,
    @Request() req,
  ) {
    return this.projectsService.getProjectBySlugsFull(
      orgSlug,
      projectSlug,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      },
    );
  }

  @Post('ingresses/validate-dns')

  async validateIngressDns(
    @Body()
    body: {
      domain: string;
    }
  ) {
    return this.projectsService.validateIngressDns(body.domain);
  }

  @Post()

  async createProject(
    @Body()
    body: {
      organizationId: string;
      name: string;
      slug?: string;
      description?: string;
      repositoryUrl?: string;
      icon?: string;
      backgroundImage?: string;
    },
    @Request() req
  ) {
    const { organizationId, name, slug, description, repositoryUrl, icon, backgroundImage } = body;
    return this.projectsService.createProject(
      organizationId,
      { name, slug, description, repositoryUrl, icon, backgroundImage },
      req.user.hackClubId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName || req.user.name?.split(' ')[0],
        lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
        imageUrl: req.user.imageUrl,
      }
    );
  }

  @Patch(':id')
  async updateProject(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      repositoryUrl?: string | null;
      icon?: string | null;
      backgroundImage?: string | null;
    },
    @Request() req
  ) {
    return this.projectsService.updateProject(
      id,
      body,
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

  @Post(':id/icon')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProjectIcon(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('File size exceeds 2MB limit');
    }
    return this.projectsService.uploadProjectAsset(
      id, 'icon', file, this.storageService,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      },
    );
  }

  @Post(':id/background-image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProjectBackground(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only JPEG, PNG, and WebP are allowed');
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new BadRequestException('File size exceeds 8MB limit');
    }
    return this.projectsService.uploadProjectAsset(
      id, 'backgroundImage', file, this.storageService,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      },
    );
  }

  @Delete(':id')

  async deleteProject(@Param('id') id: string, @Request() req) {
    return this.projectsService.deleteProject(
      id,
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

  @Get(':id')

  async getProject(@Param('id') id: string, @Request() req) {
    return this.projectsService.getProject(
      id,
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

  @Get(':id/deployments')

  async getProjectDeployments(@Param('id') id: string, @Request() req) {
    return this.projectsService.getProjectDeployments(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/members')
  async addProjectMember(
    @Param('id') id: string,
    @Body() body: { email: string; role: string },
    @Request() req
  ) {
    return this.projectsService.addProjectMember(
      id,
      body.email,
      body.role,
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

  @Delete(':id/members/:memberId')
  async removeProjectMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Request() req
  ) {
    return this.projectsService.removeProjectMember(
      id,
      memberId,
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

  @Patch(':id/members/:memberId')
  async updateProjectMemberRole(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body('role') role: string,
    @Request() req
  ) {
    return this.projectsService.updateProjectMemberRole(
      id,
      memberId,
      role,
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

  @Post(':id/databases')

  async createDatabase(
    @Param('id') id: string,
    @Body() body: {
      name: string;
      storageSize?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      restoreFromUrl?: string;
    },
    @Request() req
  ) {
    return this.projectsService.createDatabase(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get(':id/databases')

  async getProjectDatabases(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertProjectView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getProjectDatabases(id);
  }

  @Post(':id/ingresses')

  async createProjectIngress(
    @Param('id') id: string,
    @Body()
    body: {
      host: string;
      tlsEnabled?: boolean;
      routes: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.projectsService.createProjectIngress(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Put(':id/ingresses/:ingressId')

  async updateProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Body()
    body: {
      host: string;
      tlsEnabled?: boolean;
      routes: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.projectsService.updateProjectIngress(id, ingressId, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get(':id/ingresses/:ingressId')

  async getProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.projectsService.getProjectIngress(id, ingressId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Delete(':id/ingresses/:ingressId')

  async deleteProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.projectsService.deleteProjectIngress(id, ingressId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/deployments')

  async createDeployment(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      image: string;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
    },
    @Request() req
  ) {
    const { name, image, port, ports, replicas, env, exposePublic, volumes, cpuRequestMilli, memoryRequestBytes } = body;
    return this.projectsService.createDeployment(
      id,
      { name, image, port, ports, replicas, env, exposePublic, volumes, cpuRequestMilli, memoryRequestBytes },
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

  @Post(':id/deployments/from-github')

  async createDeploymentFromGitHub(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      repoUrl?: string;
      githubRepo?: string;
      branch?: string;
      dockerfilePath?: string;
      target?: string;
      tag?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
    },
    @Request() req
  ) {
    return this.projectsService.createDeploymentFromGitHub(
      id,
      body,
      req.user.hackClubId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName || req.user.name?.split(' ')[0],
        lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
        imageUrl: req.user.imageUrl,
      }
    );
  }
}

@Auth()
@Controller('deployments')
export class DeploymentsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly webhooksService: WebhooksService,
    private readonly faviconService: FaviconService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get(':id/metrics')
  async getDeploymentMetrics(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string,
  ) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(1000, Number(stepStr) || 30_000);
    if (end <= start) throw new BadRequestException('end must be > start');

    const dep = await this.projectsService.getDeployment(id);
    if (!dep?.namespace || !dep?.name) {
      throw new BadRequestException('Deployment has no namespace/name');
    }

    const data = await this.metricsService.fetchDeploymentMetrics({
      namespace: dep.namespace,
      deploymentName: dep.name,
      startMs: start,
      endMs: end,
      stepMs: step,
    });
    return { start, end, step, data };
  }

  @Patch(':id/strategy')
  async updateDeploymentStrategy(
    @Param('id') id: string,
    @Body() body: { strategy: 'rollingUpdate' | 'recreate' },
    @Request() req,
  ) {
    const { access } = await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Your role does not allow you to change the deploy strategy');
    }
    return this.projectsService.updateDeploymentStrategy(id, body.strategy);
  }

  @Patch(':id/image')
  async updateDeploymentImage(
    @Param('id') id: string,
    @Body() body: { image: string },
    @Request() req,
  ) {
    const { access } = await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Your role does not allow you to change the deployment image');
    }
    return this.projectsService.updateDeploymentImage(id, body.image);
  }

  @Patch(':id/resources')
  async updateResources(
    @Param('id') id: string,
    @Body() body: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    @Request() req,
  ) {
    const { access } = await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Your role does not allow you to update deployment resources');
    }
    return this.projectsService.updateDeploymentResources(id, {
      cpuRequestMilli: body.cpuRequestMilli ?? null,
      memoryRequestBytes: body.memoryRequestBytes ?? null,
    });
  }

  @Get()

  async listDeployments(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listDeploymentsSummary(req.user.sub, orgId);
  }

  @Get('recent-builds')

  async listRecentBuilds(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listRecentBuilds(req.user.sub, orgId);
  }

  @Get('favicon')

  async getFavicon(@Query('domain') domain: string, @Res() res: Response) {
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid domain' });
    }

    const url = await this.faviconService.getFavicon(domain);
    if (url) {
      // Redirect to the R2-cached image with long browser cache
      return res.redirect(301, url);
    }
    return res.status(HttpStatus.NOT_FOUND).json({ error: 'No favicon found' });
  }

  @Get(':id')

  async getDeployment(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getDeployment(id);
  }

  @Get(':id/logs')

  async getDeploymentLogs(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    const deployment = await this.projectsService.getDeployment(id);
    return {
      logs: deployment.buildLogs || '',
      status: deployment.status,
      buildError: deployment.buildError,
    };
  }

  @Post(':id/cancel')

  async cancelDeploymentBuild(@Param('id') id: string, @Request() req) {
    return this.projectsService.cancelDeploymentBuild(
      id,
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

  @Delete(':id')

  async deleteDeployment(@Param('id') id: string, @Request() req) {
    return this.projectsService.deleteDeployment(
      id,
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

  @Get(':id/pods')

  async getDeploymentPods(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getDeploymentPods(id);
  }

  @Post(':id/rebuild')

  async rebuildDeployment(@Param('id') id: string, @Request() req) {
    return this.projectsService.rebuildDeployment(
      id,
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

  @Post(':id/scale')

  async scaleDeployment(
    @Param('id') id: string,
    @Body() body: { replicas: number },
    @Request() req
  ) {
    return this.projectsService.scaleDeployment(
      id,
      body.replicas,
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

  @Post(':id/restart')

  async restartDeployment(
    @Param('id') id: string,
    @Request() req
  ) {
    return this.projectsService.restartDeployment(
      id,
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

  @Get(':id/image-history')

  async getImageHistory(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getImageHistory(id);
  }

  @Get(':id/image-history/:imageHistoryId/logs')

  async getImageHistoryLogs(
    @Param('id') id: string,
    @Param('imageHistoryId') imageHistoryId: string,
    @Request() req,
  ) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getImageHistoryLogs(id, imageHistoryId);
  }

  @Post(':id/rollback/:imageHistoryId')

  async rollbackToImage(
    @Param('id') id: string,
    @Param('imageHistoryId') imageHistoryId: string,
    @Request() req
  ) {
    return this.projectsService.rollbackToImage(
      id,
      imageHistoryId,
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

  @Put(':id/env')

  async updateDeploymentEnvVars(
    @Param('id') id: string,
    @Body()
    body: {
      env: { key: string; value: string }[];
    },
    @Request() req
  ) {
    return this.projectsService.updateDeploymentEnvVars(
      id,
      body.env || [],
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

  @Put(':id/build-from-root')

  async updateDeploymentBuildFromRoot(
    @Param('id') id: string,
    @Body()
    body: {
      buildFromRoot: boolean;
      buildWithDepot?: boolean;
    },
    @Request() req
  ) {
    return this.projectsService.updateDeploymentBuildFromRoot(
      id,
      body.buildFromRoot,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      },
      body.buildWithDepot,
    );
  }

  @Put(':id/health-check')

  async updateDeploymentHealthCheck(
    @Param('id') id: string,
    @Body()
    body: {
      healthCheckEnabled: boolean;
      healthCheckType: string;
      healthCheckPath?: string;
      healthCheckPort?: number;
      healthCheckCommand?: string;
      livenessEnabled: boolean;
      readinessEnabled: boolean;
      startupEnabled: boolean;
      healthCheckInterval: number;
      healthCheckTimeout: number;
      healthCheckRetries: number;
      startupFailureThreshold: number;
    },
    @Request() req
  ) {
    return this.projectsService.updateDeploymentHealthCheck(
      id,
      body,
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

  @Put(':id/volumes')

  async updateDeploymentVolumes(
    @Param('id') id: string,
    @Body()
    body: {
      volumes: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
    },
    @Request() req
  ) {
    return this.projectsService.updateDeploymentVolumes(
      id,
      body.volumes || [],
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

  @Post(':id/ingresses')

  async createDeploymentIngress(
    @Param('id') id: string,
    @Body()
    body: {
      host: string;
      path?: string;
      serviceName?: string;
      servicePort?: number;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      routes?: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.projectsService.createDeploymentIngress(
      id,
      body,
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

  @Put(':deploymentId/ingresses/:ingressId')

  async updateDeploymentIngress(
    @Param('deploymentId') deploymentId: string,
    @Param('ingressId') ingressId: string,
    @Body()
    body: {
      host: string;
      path?: string;
      serviceName?: string;
      servicePort?: number;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      basicAuth?: {
        enabled: boolean;
        username?: string;
        password?: string;
      };
    },
    @Request() req
  ) {
    return this.projectsService.updateDeploymentIngress(
      deploymentId,
      ingressId,
      body,
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

  @Delete(':deploymentId/ingresses/:ingressId')

  async deleteDeploymentIngress(
    @Param('deploymentId') deploymentId: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.projectsService.deleteDeploymentIngress(
      deploymentId,
      ingressId,
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

  @Post(':deploymentId/services')

  async createDeploymentService(
    @Param('deploymentId') deploymentId: string,
    @Body()
    body: {
      name: string;
      ports: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      exposePublic?: boolean;
      domain?: string | null;
    },
    @Request() req
  ) {
    return this.projectsService.createDeploymentService(
      deploymentId,
      body,
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

  @Put(':deploymentId/services/:serviceId')

  async updateServiceConfiguration(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Body()
    body: {
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      domain?: string | null;
    },
    @Request() req
  ) {
    return this.projectsService.updateServiceConfiguration(
      deploymentId,
      serviceId,
      {
        ports: body.ports,
        domain: body.domain,
      },
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

  @Delete(':deploymentId/services/:serviceId')

  async deleteDeploymentService(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Request() req
  ) {
    return this.projectsService.deleteDeploymentService(
      deploymentId,
      serviceId,
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

  @Patch(':deploymentId/services/:serviceId/exposure')

  async updateServiceExposure(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Body()
    body: {
      exposePublic: boolean;
    },
    @Request() req
  ) {
    return this.projectsService.updateServiceExposure(
      deploymentId,
      serviceId,
      Boolean(body.exposePublic),
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

  @Post(':deploymentId/services/:serviceId/ports/:portId/public')
  async enableServicePortPublic(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Param('portId') portId: string,
    @Request() req,
  ) {
    return this.projectsService.enableServicePortPublic(
      deploymentId, serviceId, portId, req.user.sub,
      {
        email: req.user.email, username: req.user.username,
        firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
      },
    );
  }

  @Delete(':deploymentId/services/:serviceId/ports/:portId/public')
  async disableServicePortPublic(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Param('portId') portId: string,
    @Request() req,
  ) {
    return this.projectsService.disableServicePortPublic(
      deploymentId, serviceId, portId, req.user.sub,
      {
        email: req.user.email, username: req.user.username,
        firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
      },
    );
  }

  // Auto-deploy endpoints

  @Get(':id/auto-deploy')

  async getAutoDeployStatus(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getAutoDeployStatus(id);
  }

  @Post(':id/auto-deploy/enable')

  async enableAutoDeploy(
    @Param('id') id: string,
    @Body() body: { branch: string },
    @Request() req
  ) {
    return this.projectsService.enableAutoDeploy(
      id,
      body.branch,
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

  @Post(':id/auto-deploy/disable')

  async disableAutoDeploy(@Param('id') id: string, @Request() req) {
    return this.projectsService.disableAutoDeploy(
      id,
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

  @Get(':id/github-deployments')

  async getGitHubDeployments(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDeploymentView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getGitHubDeployments(id);
  }

  // Webhook token management endpoints

  @Get(':id/webhook-tokens')

  async listWebhookTokens(@Param('id') id: string, @Request() req) {
    return this.webhooksService.listWebhookTokens(id, req.user.sub);
  }

  @Post(':id/webhook-tokens')

  async createWebhookToken(
    @Param('id') id: string,
    @Body() body: { label?: string },
    @Request() req,
  ) {
    return this.webhooksService.createWebhookToken(id, req.user.sub, body?.label);
  }

  @Delete(':id/webhook-tokens/:tokenId')

  async deleteWebhookToken(
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
    @Request() req,
  ) {
    return this.webhooksService.deleteWebhookToken(id, tokenId, req.user.sub);
  }
}

@Auth()
@Controller('ingresses')
export class IngressesController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get(':id')

  async getIngress(@Param('id') id: string, @Request() req) {
    return this.projectsService.getIngressById(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }
}

@Auth()
@Controller('databases')
export class DatabasesController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async listDatabases(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listDatabasesSummary(req.user.sub, orgId);
  }

  @Get(':id')

  async getDatabase(@Param('id') id: string, @Request() req) {
    await this.projectsService.assertDatabaseView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    return this.projectsService.getDatabase(id);
  }

  @Patch(':id/resources')
  async updateDatabaseResources(
    @Param('id') id: string,
    @Body() body: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    @Request() req,
  ) {
    const { access } = await this.projectsService.assertDatabaseView(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Your role does not allow you to update database resources');
    }
    return this.projectsService.updateDatabaseResources(id, {
      cpuRequestMilli: body.cpuRequestMilli ?? null,
      memoryRequestBytes: body.memoryRequestBytes ?? null,
    });
  }

  @Delete(':id')

  async deleteDatabase(@Param('id') id: string, @Request() req) {
    return this.projectsService.deleteDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get(':id/backups')
  async listBackups(@Param('id') id: string, @Request() req) {
    return this.projectsService.listDatabaseBackups(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/backups')
  async createBackup(
    @Param('id') id: string,
    @Body() body: { label?: string; type?: 'full' | 'diff' | 'incr' },
    @Request() req
  ) {
    return this.projectsService.createDatabaseBackup(id, body || {}, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/restore')
  async restoreBackup(
    @Param('id') id: string,
    @Body() body: { backupId?: string },
    @Request() req
  ) {
    return this.projectsService.restoreDatabaseBackup(id, body?.backupId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }

  @Get(':id/extensions')
  async listExtensions(@Param('id') id: string, @Request() req) {
    return this.projectsService.listDatabaseExtensions(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/extensions')
  async installExtension(
    @Param('id') id: string,
    @Body() body: { name: string; addToPreload?: boolean },
    @Request() req,
  ) {
    return this.projectsService.installDatabaseExtension(id, body, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Delete(':id/extensions/:name')
  async uninstallExtension(
    @Param('id') id: string,
    @Param('name') name: string,
    @Query('removeFromPreload') removeFromPreload: string,
    @Request() req,
  ) {
    return this.projectsService.uninstallDatabaseExtension(
      id, { name, removeFromPreload: removeFromPreload === 'true' }, req.user.sub,
      {
        email: req.user.email, username: req.user.username,
        firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
      },
    );
  }

  @Get(':id/settings')
  async getSettings(@Param('id') id: string, @Request() req) {
    return this.projectsService.getDatabaseSettings(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Post(':id/public')
  async enablePublic(@Param('id') id: string, @Request() req) {
    return this.projectsService.enableDatabasePublic(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Delete(':id/public')
  async disablePublic(@Param('id') id: string, @Request() req) {
    return this.projectsService.disableDatabasePublic(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Get(':id/backup-schedule')
  async getBackupSchedule(@Param('id') id: string, @Request() req) {
    return this.projectsService.getBackupSchedule(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Put(':id/backup-schedule')
  async setBackupSchedule(
    @Param('id') id: string,
    @Body() body: { cron: string },
    @Request() req,
  ) {
    return this.projectsService.setBackupSchedule(id, body, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Delete(':id/backup-schedule')
  async clearBackupSchedule(@Param('id') id: string, @Request() req) {
    return this.projectsService.deleteBackupSchedule(id, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }

  @Patch(':id/settings')
  async updateSettings(
    @Param('id') id: string,
    @Body() body: { parameters: Record<string, string> },
    @Request() req,
  ) {
    return this.projectsService.updateDatabaseSettings(id, body, req.user.sub, {
      email: req.user.email, username: req.user.username,
      firstName: req.user.firstName, lastName: req.user.lastName, imageUrl: req.user.imageUrl,
    });
  }
}
