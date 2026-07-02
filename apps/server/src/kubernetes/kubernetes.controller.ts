import { Body, Controller, Delete, Get, Param, Post, Query, Req, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { K8sWorkloadService } from './k8s-workload.service';
import { K8sNetworkService } from './k8s-network.service';
import { Auth, RequireScope } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Auth()
@Controller()
export class KubernetesController {
  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
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
    return this.k8sWorkload.listPods(namespace);
  }

  @Get('pods/:podName')
  async getPod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.k8sWorkload.getPod(podName, namespace);
  }

  @Delete('pods/:podName')
  async deletePod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'delete a pod');
    return this.k8sWorkload.deletePod(podName, namespace);
  }

  @Get('pods/:podName/logs')
  async getPodLogs(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('container') container?: string,
    @Query('tailLines') tailLines?: string,
    @Query('previous') previous?: string,
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'stream pod logs');
    const parsedTailLines = tailLines ? parseInt(tailLines) : 100;
    const wantPrevious = previous === 'true' || previous === '1';
    return this.k8sWorkload.getPodLogs(podName, namespace, container, parsedTailLines, wantPrevious);
  }

  // Synchronous one-shot exec. Used by the MCP exec tool and any non-WS
  // caller — the websocket terminal gateway handles interactive sessions.
  // Requires the `exec` API-token scope (the default for POST is `deploy`,
  // which is insufficient — exec is shell access and demands an explicit
  // higher-privilege scope, matching the WS terminal gateway).
  @Post('pods/:podName/exec')
  @RequireScope('exec')
  async execInPod(
    @Param('podName') podName: string,
    @Body() body: { namespace?: string; command: string | string[]; container?: string; timeoutMs?: number },
    @Req() req: any,
    @Query('namespace') namespaceQuery?: string,
  ) {
    const namespace = (body?.namespace || namespaceQuery || '').trim();
    if (!namespace) throw new BadRequestException('namespace is required');
    await this.resolveNamespace(namespace, req, 'edit', 'exec in pod');

    const cmd: string[] = Array.isArray(body?.command)
      ? body.command
      : typeof body?.command === 'string' && body.command.trim()
        ? ['/bin/sh', '-c', body.command]
        : [];
    if (cmd.length === 0) {
      throw new BadRequestException('command is required (string or string[])');
    }

    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 60_000, 1_000), 300_000);
    const result = await Promise.race([
      this.k8sCnpg.runExec(namespace, podName, cmd, body?.container),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new BadRequestException(`exec timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return result;
  }

  @Get('endpoints')
  async listEndpoints(@Query('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.k8sNetwork.listEndpoints(namespace);
  }

  @Get('sync/:namespace')
  async syncNamespace(@Param('namespace') namespace: string, @Req() req: any) {
    // syncing pulls live cluster state into our DB for a namespace — requires edit
    // rights because it can clobber records and is server-side expensive.
    await this.resolveNamespace(namespace, req, 'edit', 'sync namespace state');
    return this.k8sWorkload.syncNamespaceToDatabase(namespace);
  }
}
