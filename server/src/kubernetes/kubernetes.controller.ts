import { Controller, Get, Param, Query, Post, Body, UseGuards, Patch } from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller()
export class KubernetesController {
  constructor(private readonly kubernetesService: KubernetesService) {}

  @Get('pods')
  @UseGuards(AuthGuard)
  async listPods(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listPods(namespace);
  }

  @Get('pods/:podName')
  @UseGuards(AuthGuard)
  async getPod(
    @Param('podName') podName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.getPod(podName, namespace);
  }

  @Get('pods/:podName/logs')
  @UseGuards(AuthGuard)
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
  @UseGuards(AuthGuard)
  async listEndpoints(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listEndpoints(namespace);
  }

  @Get('deployments')
  @UseGuards(AuthGuard)
  async listDeployments(@Query('namespace') namespace?: string) {
    return this.kubernetesService.listDeployments(namespace);
  }

  @Get('sync/:namespace')
  @UseGuards(AuthGuard)
  async syncNamespace(@Param('namespace') namespace: string) {
    return this.kubernetesService.syncNamespaceToDatabase(namespace);
  }

  @Post('deployments/:deploymentName/restart')
  @UseGuards(AuthGuard)
  async restartDeployment(
    @Param('deploymentName') deploymentName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.restartDeployment(deploymentName, namespace);
  }

  @Patch('deployments/:deploymentName/scale')
  @UseGuards(AuthGuard)
  async scaleDeployment(
    @Param('deploymentName') deploymentName: string,
    @Body('replicas') replicas: number,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.scaleDeployment(deploymentName, namespace, replicas);
  }

  @Get('deployments/:deploymentName/pods')
  @UseGuards(AuthGuard)
  async getDeploymentPods(
    @Param('deploymentName') deploymentName: string,
    @Query('namespace') namespace?: string
  ) {
    return this.kubernetesService.getDeploymentPods(deploymentName, namespace);
  }
}

