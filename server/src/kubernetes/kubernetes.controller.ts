import { Controller, Get, Param, Query } from '@nestjs/common';
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

  @Get('sync/:namespace')

  async syncNamespace(@Param('namespace') namespace: string) {
    return this.kubernetesService.syncNamespaceToDatabase(namespace);
  }
}

