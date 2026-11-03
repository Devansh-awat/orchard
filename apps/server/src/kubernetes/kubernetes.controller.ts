import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  BadRequestException,
  NotFoundException,
  ForbiddenException
} from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { K8sWorkloadService } from './k8s-workload.service';
import { K8sNetworkService } from './k8s-network.service';
import { Auth, RequireScope } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveNamespaceScope } from '../projects/namespace-scope';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

@Auth()
@Controller()
export class KubernetesController {
  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly authz: AuthorizationService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Resolve a namespace to its owning project and require the caller has the
   * appropriate access. Returns 404 (not 403) when the caller has no path to
   * the project: matches the wider RBAC contract.
   */
  private async resolveNamespace(
    namespace: string | undefined,
    req: any,
    mode: 'view' | 'edit',
    action = 'access this namespace'
  ) {
    if (!namespace) throw new BadRequestException('namespace query parameter is required');
    const scope = await resolveNamespaceScope(this.prisma, namespace);
    if (!scope) throw new NotFoundException(`Namespace ${namespace} not found`);
    const userId = await this.resolveUserId(req);
    if (mode === 'edit') {
      await this.authz.requireProjectEdit(scope.projectId, userId, action);
      return { projectId: scope.projectId, canEdit: true };
    }
    const access = await this.authz.requireProjectView(scope.projectId, userId);
    return { projectId: scope.projectId, canEdit: access.canEdit };
  }

  /**
   * Viewers get env var values nulled on the deployment path
   * (`scrubDeploymentForViewer`); the pod manifest carries the same values in
   * `spec.containers[].env` and has to match. Secret-flagged vars reach the
   * container through `secretKeyRef` and were never in the manifest to begin
   * with, so `valueFrom` entries are left intact.
   */
  private static scrubPodForViewer(pod: any): any {
    if (!pod?.spec) return pod;
    const scrubContainers = (containers: any[] | undefined) =>
      containers?.map((c: any) => ({
        ...c,
        env: c.env?.map((e: any) => (e?.value !== undefined ? { ...e, value: null } : e))
      }));
    return {
      ...pod,
      spec: {
        ...pod.spec,
        containers: scrubContainers(pod.spec.containers),
        initContainers: scrubContainers(pod.spec.initContainers),
        ephemeralContainers: scrubContainers(pod.spec.ephemeralContainers)
      }
    };
  }

  private async resolveUserId(req: any): Promise<string> {
    const sub = req.user?.sub as string | undefined;
    if (!sub) throw new ForbiddenException('Not authenticated');
    if (UUID_RE.test(sub)) return sub;
    const user = await this.prisma.user.findFirst({
      where: { externalAuthId: sub },
      select: { id: true }
    });
    if (!user) throw new ForbiddenException('User not found');
    return user.id;
  }

  @Get('pods')
  async listPods(
    @Query('namespace') namespace: string,
    @Req() req: any,
    @Query('live') live?: string
  ) {
    await this.resolveNamespace(namespace, req, 'view');
    if (live === '1' || live === 'true') {
      return this.k8sWorkload.listPods(namespace);
    }
    const objects = await this.prisma.k8sObject.findMany({
      where: { kind: 'Pod', namespace },
      select: { manifest: true }
    });
    const pods = objects.map((o) => {
      const pod = o.manifest as any;
      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        status: pod.status?.phase,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        startTime: pod.status?.startTime,
        conditions: pod.status?.conditions,
        containerStatuses: pod.status?.containerStatuses?.map((container: any) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          state: container.state
        })),
        labels: pod.metadata?.labels,
        annotations: pod.metadata?.annotations
      };
    });
    return { namespace, podCount: pods.length, pods };
  }

  @Get('pods/:podName')
  async getPod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('live') live?: string
  ) {
    const access = await this.resolveNamespace(namespace, req, 'view');
    const scrub = (pod: any) =>
      access.canEdit ? pod : KubernetesController.scrubPodForViewer(pod);
    if (live === '1' || live === 'true') {
      return scrub(await this.k8sWorkload.getPod(podName, namespace));
    }
    const object = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Pod', namespace, name: podName },
      select: { manifest: true }
    });
    if (!object) return scrub(await this.k8sWorkload.getPod(podName, namespace));
    return scrub(object.manifest);
  }

  @Delete('pods/:podName')
  async deletePod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string
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
    @Query('sinceSeconds') sinceSeconds?: string,
    @Query('sinceTime') sinceTime?: string
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'stream pod logs');
    if (sinceSeconds && sinceTime) {
      throw new BadRequestException('sinceSeconds and sinceTime are mutually exclusive');
    }
    const parsedSinceSeconds = sinceSeconds ? parseInt(sinceSeconds, 10) : undefined;
    if (sinceSeconds && (!Number.isInteger(parsedSinceSeconds) || parsedSinceSeconds <= 0)) {
      throw new BadRequestException('sinceSeconds must be a positive integer');
    }
    if (sinceTime && (!RFC3339_RE.test(sinceTime) || Number.isNaN(Date.parse(sinceTime)))) {
      throw new BadRequestException('sinceTime must be an RFC3339 timestamp');
    }
    const parsedTailLines = tailLines ? parseInt(tailLines, 10) : 100;
    const wantPrevious = previous === 'true' || previous === '1';
    return this.k8sWorkload.getPodLogs(
      podName,
      namespace,
      container,
      parsedTailLines,
      wantPrevious,
      parsedSinceSeconds,
      sinceTime
    );
  }

  // Synchronous one-shot exec. Used by the MCP exec tool and any non-WS
  // caller: the websocket terminal gateway handles interactive sessions.
  // Requires the `exec` API-token scope (the default for POST is `deploy`,
  // which is insufficient: exec is shell access and demands an explicit
  // higher-privilege scope, matching the WS terminal gateway).
  @Post('pods/:podName/exec')
  @RequireScope('exec')
  async execInPod(
    @Param('podName') podName: string,
    @Body() body: {
      namespace?: string;
      command: string | string[];
      container?: string;
      timeoutMs?: number;
    },
    @Req() req: any,
    @Query('namespace') namespaceQuery?: string
  ) {
    const namespace = (body?.namespace || namespaceQuery || '').trim();
    if (!namespace) throw new BadRequestException('namespace is required');
    await this.resolveNamespace(namespace, req, 'edit', 'exec in pod');

    let cmd: string[] = [];
    if (Array.isArray(body?.command)) {
      cmd = body.command;
    } else if (typeof body?.command === 'string' && body.command.trim()) {
      cmd = ['/bin/sh', '-c', body.command];
    }
    if (cmd.length === 0) {
      throw new BadRequestException('command is required (string or string[])');
    }

    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 60_000, 1_000), 300_000);
    const result = await Promise.race([
      this.k8sCnpg.runExec(namespace, podName, cmd, body?.container),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new BadRequestException(`exec timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
    return result;
  }

  @Get('endpoints')
  async listEndpoints(@Query('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.k8sNetwork.listEndpoints(namespace);
  }

  @Get('sync/:namespace')
  @RequireScope('deploy')
  async syncNamespace(@Param('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'edit', 'sync namespace state');
    return this.k8sWorkload.syncNamespaceToDatabase(namespace);
  }
}
