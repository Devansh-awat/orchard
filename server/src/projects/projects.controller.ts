import { Controller, Get, Param, UseGuards, Post, Body, Request, Delete, Put, Patch } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post('ingresses/validate-dns')
  @UseGuards(AuthGuard)
  async validateIngressDns(
    @Body()
    body: {
      domain: string;
    }
  ) {
    return this.projectsService.validateIngressDns(body.domain);
  }

  @Post()
  @UseGuards(AuthGuard)
  async createProject(
    @Body()
    body: {
      workspaceId: string;
      name: string;
      slug?: string;
      description?: string;
      repositoryUrl?: string;
    },
    @Request() req
  ) {
    const { workspaceId, name, slug, description, repositoryUrl } = body;
    return this.projectsService.createProject(
      workspaceId,
      { name, slug, description, repositoryUrl },
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async getProjectDeployments(@Param('id') id: string) {
    return this.projectsService.getProjectDeployments(id);
  }

  @Post(':id/databases')
  @UseGuards(AuthGuard)
  async createDatabase(
    @Param('id') id: string,
    @Body() body: { name: string },
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
  @UseGuards(AuthGuard)
  async getProjectDatabases(@Param('id') id: string) {
    return this.projectsService.getProjectDatabases(id);
  }

  @Post(':id/ingresses')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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

  @Post(':id/deployments')
  @UseGuards(AuthGuard)
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
        hostPath?: string;
        readOnly?: boolean;
      }[];
    },
    @Request() req
  ) {
    const { name, image, port, ports, replicas, env, exposePublic, volumes } = body;
    return this.projectsService.createDeployment(
      id,
      { name, image, port, ports, replicas, env, exposePublic, volumes },
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
  @UseGuards(AuthGuard)
  async createDeploymentFromGitHub(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
      target?: string;
      tag?: string;
      buildFromRoot?: boolean;
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
        hostPath?: string;
        readOnly?: boolean;
      }[];
    },
    @Request() req
  ) {
    return this.projectsService.createDeploymentFromGitHub(
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
}

@Controller('deployments')
export class DeploymentsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly webhooksService: WebhooksService,
  ) {}

  @Get(':id')
  @UseGuards(AuthGuard)
  async getDeployment(@Param('id') id: string) {
    return this.projectsService.getDeployment(id);
  }

  @Get(':id/logs')
  @UseGuards(AuthGuard)
  async getDeploymentLogs(@Param('id') id: string) {
    const deployment = await this.projectsService.getDeployment(id);
    return {
      logs: deployment.buildLogs || '',
      status: deployment.status,
      buildError: deployment.buildError,
    };
  }

  @Post(':id/cancel')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async getDeploymentPods(@Param('id') id: string) {
    return this.projectsService.getDeploymentPods(id);
  }

  @Post(':id/rebuild')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async getImageHistory(@Param('id') id: string) {
    return this.projectsService.getImageHistory(id);
  }

  @Post(':id/rollback/:imageHistoryId')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async updateDeploymentBuildFromRoot(
    @Param('id') id: string,
    @Body()
    body: {
      buildFromRoot: boolean;
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
      }
    );
  }

  @Put(':id/health-check')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async updateDeploymentVolumes(
    @Param('id') id: string,
    @Body()
    body: {
      volumes: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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

  // Auto-deploy endpoints

  @Get(':id/auto-deploy')
  @UseGuards(AuthGuard)
  async getAutoDeployStatus(@Param('id') id: string) {
    return this.projectsService.getAutoDeployStatus(id);
  }

  @Post(':id/auto-deploy/enable')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async getGitHubDeployments(@Param('id') id: string) {
    return this.projectsService.getGitHubDeployments(id);
  }

  // Webhook token management endpoints

  @Get(':id/webhook-tokens')
  @UseGuards(AuthGuard)
  async listWebhookTokens(@Param('id') id: string, @Request() req) {
    return this.webhooksService.listWebhookTokens(id, req.user.sub);
  }

  @Post(':id/webhook-tokens')
  @UseGuards(AuthGuard)
  async createWebhookToken(
    @Param('id') id: string,
    @Body() body: { label?: string },
    @Request() req,
  ) {
    return this.webhooksService.createWebhookToken(id, req.user.sub, body?.label);
  }

  @Delete(':id/webhook-tokens/:tokenId')
  @UseGuards(AuthGuard)
  async deleteWebhookToken(
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
    @Request() req,
  ) {
    return this.webhooksService.deleteWebhookToken(id, tokenId, req.user.sub);
  }
}

@Controller('ingresses')
export class IngressesController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get(':id')
  @UseGuards(AuthGuard)
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

@Controller('databases')
export class DatabasesController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get(':id')
  @UseGuards(AuthGuard)
  async getDatabase(@Param('id') id: string) {
    return this.projectsService.getDatabase(id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async deleteDatabase(@Param('id') id: string, @Request() req) {
    return this.projectsService.deleteDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl,
    });
  }
}
