import { Controller, Delete, Get, Param, Query, Req, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Auth()
@Controller()
export class KubernetesController {
  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly authz: AuthorizationService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolve a namespace to its owning project and require the caller has the
   * appropriate access. Returns 404 (not 403) when the caller has no path to
   * the project — matches the wider RBAC contract.
   */
  private async resolveNamespace(namespace: string | undefined, req: any, mode: 'view' | 'edit', action = 'access this namespace') {
    if (!namespace) throw new BadRequestException('namespace query parameter is required');
    const project = await this.prisma.project.findFirst({
      where: { namespace },
      select: { id: true },
    });
    if (!project) throw new NotFoundException(`Namespace ${namespace} not found`);
    const userId = await this.resolveUserId(req);
    if (mode === 'edit') {
      await this.authz.requireProjectEdit(project.id, userId, action);
    } else {
      await this.authz.requireProjectView(project.id, userId);
    }
  }

  private async resolveUserId(req: any): Promise<string> {
    const sub = req.user?.sub as string | undefined;
    if (!sub) throw new ForbiddenException('Not authenticated');
    if (UUID_RE.test(sub)) return sub;
    const user = await this.prisma.user.findFirst({ where: { hackClubId: sub }, select: { id: true } });
    if (!user) throw new ForbiddenException('User not found');
    return user.id;
  }

  @Get('pods')
  async listPods(@Query('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.kubernetesService.listPods(namespace);
  }

  @Get('pods/:podName')
  async getPod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.kubernetesService.getPod(podName, namespace);
  }

  @Delete('pods/:podName')
  async deletePod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'delete a pod');
    return this.kubernetesService.deletePod(podName, namespace);
  }

  @Get('pods/:podName/logs')
  async getPodLogs(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('container') container?: string,
    @Query('tailLines') tailLines?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'view');
    const parsedTailLines = tailLines ? parseInt(tailLines) : 100;
    return this.kubernetesService.getPodLogs(podName, namespace, container, parsedTailLines);
  }

  @Get('endpoints')
  async listEndpoints(@Query('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.kubernetesService.listEndpoints(namespace);
  }

  @Get('sync/:namespace')
  async syncNamespace(@Param('namespace') namespace: string, @Req() req: any) {
    // syncing pulls live cluster state into our DB for a namespace — requires edit
    // rights because it can clobber records and is server-side expensive.
    await this.resolveNamespace(namespace, req, 'edit', 'sync namespace state');
    return this.kubernetesService.syncNamespaceToDatabase(namespace);
  }
}
