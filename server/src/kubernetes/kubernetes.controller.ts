import { Controller, Get, Param, Query, Post, Body, Patch } from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller()
export class KubernetesController {
  constructor(private readonly kubernetesService: KubernetesService) {}

  @Get('pods')

  async listPods(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listPods(namespace);
  }

  @Get('pods/:podName')

  async getPod(
    @Param('podName') podName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.getPod(podName, namespace);
  }

  @Get('pods/:podName/logs')

  async getPodLogs(
    @Param('podName') podName: string,
    @Query('namespace') namespace?: string,
    @Query('container') container?: string,
    @Query('tailLines') tailLines?: string
  ) {
    const parsedTailLines = tailLines ? parseInt(tailLines) : 100;
    return this.kubernetesService.getPodLogs(podName, namespace, container, parsedTailLines);
  }

  @Get('endpoints')

  async listEndpoints(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listEndpoints(namespace);
  }

  @Get('deployments')

  async listDeployments(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listDeployments(namespace);
  }

  @Get('sync/:namespace')

  async syncNamespace(@Param('namespace') namespace: string) {
    return this.kubernetesService.syncNamespaceToDatabase(namespace);
  }

  @Post('deployments/:deploymentName/restart')

  async restartDeployment(
    @Param('deploymentName') deploymentName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.restartDeployment(deploymentName, namespace);
  }

  @Patch('deployments/:deploymentName/scale')

  async scaleDeployment(
    @Param('deploymentName') deploymentName: string,
    @Body('replicas') replicas: number,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.scaleDeployment(deploymentName, namespace, replicas);
  }

  @Get('deployments/:deploymentName/pods')

  async getDeploymentPods(
    @Param('deploymentName') deploymentName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.getDeploymentPods(deploymentName, namespace);
  }
}

