import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { UsersService } from '../users/users.service';
import { DockerService } from '../docker/docker.service';
import { GitHubService } from '../github/github.service';
import { FaviconService } from './favicon.service';
import { NodesService } from '../nodes/nodes.service';
import { QuotasService } from '../quotas/quotas.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { randomUUID } from 'crypto';
import * as dns from 'dns';
import { promisify } from 'util';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly usersService: UsersService,
    private readonly dockerService: DockerService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
    private readonly faviconService: FaviconService,
    @Inject(forwardRef(() => NodesService))
    private readonly nodesService: NodesService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
    private readonly tailscaleService: TailscaleService,
  ) {}

  private async resolvePlacementForProject(projectId: string): Promise<{
    allowedNodes: string[] | null;
    deniedNodes: string[];
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    });
    if (!project) return { allowedNodes: null, deniedNodes: [] };
    const placement = await this.nodesService.getPlacementForOrg(project.organizationId);
    return { allowedNodes: placement.allowedNodes, deniedNodes: placement.deniedNodes };
  }

  private async resolveProjectIconFallback(
    deployments: Array<{ ingresses?: Array<{ host?: string | null }> | null }> | null | undefined
  ): Promise<string | null> {
    if (!deployments?.length) return null;
    for (const dep of deployments) {
      const host = dep.ingresses?.[0]?.host;
      if (!host) continue;
      const url = await this.faviconService.getFavicon(host);
      if (url) return url;
    }
    return null;
  }

  private readonly metricsLogger = new Logger('MetricsCollector');

  @Cron('*/3 * * * *')
  async collectAllDeploymentMetrics() {
    const deployments = await this.prisma.deployment.findMany({
      where: {
        status: 'running',
        name: { not: '' },
        namespace: { not: '' },
      },
      select: { id: true, name: true, namespace: true },
    });

    if (deployments.length === 0) return;

    const results = await Promise.allSettled(
      deployments.map(async (dep) => {
        const livePods = await this.kubernetesService.getDeploymentPods(dep.name, dep.namespace);
        const cpu = livePods?.totalCpuUsage ?? null;
        const mem = livePods?.totalMemoryUsage ?? null;

        if (cpu != null || mem != null) {
          await this.prisma.deploymentMetric.create({
            data: {
              deploymentId: dep.id,
              cpuUsage: cpu,
              memoryUsage: mem != null ? BigInt(mem) : null,
            },
          });
          return true;
        }
        return false;
      })
    );

    const saved = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.filter(r => r.status === 'rejected').length;
    this.metricsLogger.log(`Collected metrics for ${saved}/${deployments.length} deployments${failed > 0 ? ` (${failed} failed)` : ''}`);

    // Clean up old metrics
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await this.prisma.deploymentMetric.deleteMany({
      where: { createdAt: { lt: oneHourAgo } },
    }).catch(err => this.metricsLogger.error('Failed to clean old metrics:', err.message));
  }

  private formatSlug(value: string) {
    if (!value) {
      return '';
    }

    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }

  private buildNamespace(parts: string[]) {
    const sanitized = parts
      .map((part) => this.formatSlug(part))
      .filter((part) => part.length > 0);

    const namespace = sanitized.join('-').substring(0, 63);

    if (!namespace) {
      throw new BadRequestException('Failed to build namespace');
    }

    return namespace;
  }

  private formatLivePods(pods: Array<any> = []) {
    return pods.map((pod) => ({
      id: pod.name,
      name: pod.name,
      status: pod.status,
      ip: pod.podIp,
      podIp: pod.podIp,
      nodeName: pod.nodeName,
      restartCount: typeof pod.restartCount === 'number' ? pod.restartCount : 0,
      startTime: pod.createdAt,
      createdAt: pod.createdAt,
      cpuUsage: pod.cpuUsage ?? null,
      memoryUsage: pod.memoryUsage ?? null,
      containers:
        pod.containers?.map((container) => ({
          name: container.name,
          image: container.image,
          ready: container.ready ?? false,
          restartCount: typeof container.restartCount === 'number' ? container.restartCount : 0,
        })) ?? [],
    }));
  }

  /**
   * Compute the runtime deployment status from Kubernetes state.
   * Possible values: 'running' | 'restarting' | 'scaling' | 'failed' | 'stopped' | 'unhealthy' | 'pending'
   */
  private async computeDeploymentStatus(deployment: any): Promise<string> {
    if (deployment.replicas === 0) {
      return 'stopped';
    }

    if (!deployment.name || !deployment.namespace) {
      return deployment.status;
    }

    try {
      const livePods = await this.kubernetesService.getDeploymentPods(
        deployment.name,
        deployment.namespace
      );
      const pods = this.formatLivePods(livePods?.pods);
      const warnings = livePods?.warnings || [];

      const readyPods = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready') ?? [];
      const allPods = (pods ?? []).filter((pod: any) => pod.status?.toLowerCase() !== 'succeeded');
      const desiredReplicas = deployment.replicas || 1;

      if (allPods.length === 0) {
        return 'pending';
      }

      const hasBackOffWarning = warnings.some(warning =>
        warning.message?.toLowerCase().includes('back-off') ||
        warning.message?.toLowerCase().includes('backoff') ||
        warning.message?.toLowerCase().includes('crashloop')
      );

      const hasCrashingPods = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return restartCount > 5 && pod.status?.toLowerCase() !== 'ready';
      });

      const hasAnyRestarts = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return restartCount > 0;
      });

      // No ready pods at all
      if (readyPods.length === 0) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'failed';
        }
        // Pods exist but none ready and no crash loops — starting up or restarting
        return hasAnyRestarts ? 'restarting' : 'pending';
      }

      // Some pods ready, some not
      if (readyPods.length < desiredReplicas) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'unhealthy';
        }
        // Pods cycling with restarts = rolling restart, otherwise scaling up
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // More total pods than desired = scaling down or rolling restart in progress
      if (allPods.length > desiredReplicas) {
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // All desired replicas are ready
      if (hasBackOffWarning) {
        return 'unhealthy';
      }

      return 'running';
    } catch (error) {
      console.error(
        `[ProjectsService] Failed to compute status for deployment ${deployment.id}:`,
        error instanceof Error ? error.message : error
      );
      return deployment.status;
    }
  }

  private addInternalUrlsToServices(services: any[], namespace: string) {
    if (!Array.isArray(services) || !namespace) {
      return services;
    }

    return services.map((service) => {
      const serviceName = service.name;
      const ports = service.ports || [];
      
      const internalUrls = ports.map((port: any) => {
        const portNumber = port.port || service.port || 80;
        return `${serviceName}.${namespace}.svc.cluster.local:${portNumber}`;
      });

      return {
        ...service,
        internalUrl: internalUrls.length > 0 ? internalUrls[0] : `${serviceName}.${namespace}.svc.cluster.local:${service.port || 80}`,
        internalUrls: internalUrls.length > 0 ? internalUrls : [`${serviceName}.${namespace}.svc.cluster.local:${service.port || 80}`],
      };
    });
  }

  private addInternalUrlsToDeployment(deployment: any) {
    if (!deployment || !deployment.namespace) {
      return deployment;
    }

    if (deployment.services && Array.isArray(deployment.services)) {
      const servicesWithInternalUrls = this.addInternalUrlsToServices(
        deployment.services,
        deployment.namespace
      );
      return {
        ...deployment,
        services: servicesWithInternalUrls,
      };
    }

    return deployment;
  }

  private normalizeServicePortInputs(
    ports?: {
      name?: string;
      containerPort?: number;
      servicePort?: number;
      protocol?: string;
      nodePort?: number;
    }[],
    options: { requireAtLeastOne?: boolean } = {}
  ) {
    const mapped: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    if (!Array.isArray(ports)) {
      if (options.requireAtLeastOne) {
        throw new BadRequestException('At least one valid port is required');
      }
      return mapped;
    }

    for (const entry of ports) {
      if (!entry) {
        continue;
      }

      const containerPort = Number(entry.containerPort ?? entry.servicePort ?? 0);
      const servicePort = Number(entry.servicePort ?? entry.containerPort ?? 0);

      if (!Number.isInteger(containerPort) || containerPort <= 0) {
        continue;
      }

      if (!Number.isInteger(servicePort) || servicePort <= 0) {
        continue;
      }

      const protocol =
        typeof entry.protocol === 'string' && entry.protocol.trim().length > 0
          ? entry.protocol.trim().toUpperCase()
          : 'TCP';

      const nodePortValue =
        entry.nodePort === undefined || entry.nodePort === null
          ? undefined
          : Number(entry.nodePort);

      const nodePort =
        nodePortValue !== undefined && Number.isInteger(nodePortValue) && nodePortValue > 0
          ? nodePortValue
          : undefined;

      const name =
        typeof entry.name === 'string' && entry.name.trim().length > 0
          ? entry.name.trim()
          : undefined;

      mapped.push({
        name,
        containerPort,
        servicePort,
        protocol,
        nodePort,
      });
    }

    if (mapped.length === 0 && options.requireAtLeastOne) {
      throw new BadRequestException('At least one valid port is required');
    }

    return mapped;
  }

  async createProject(
    organizationId: string,
    data: { name: string; slug?: string; description?: string; repositoryUrl?: string; icon?: string; backgroundImage?: string },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Check org membership
    const orgMembership = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId: user.id },
    });

    if (!orgMembership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const name = String(data.name || '').trim();

    if (!name) {
      throw new BadRequestException('Project name is required');
    }

    const slugSource = data.slug && data.slug.trim() ? data.slug : name;
    const slug = this.formatSlug(slugSource);

    if (!slug) {
      throw new BadRequestException('Project slug cannot be empty');
    }

    const existing = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId,
          slug,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('A project with this slug already exists');
    }

    const namespace = this.buildNamespace([
      organization.slug,
      slug,
    ]);

    const namespaceInUse = await this.prisma.project.findFirst({
      where: { namespace },
    });

    if (namespaceInUse) {
      throw new BadRequestException('Generated namespace is already in use');
    }

    const namespaceResult = await this.kubernetesService.createNamespace(namespace);

    if (!namespaceResult.created) {
      throw new BadRequestException('Kubernetes namespace already exists');
    }

    // Create project and add creator as owner
    const adminRole = await this.prisma.role.findFirst({ where: { name: 'admin' } });

    const project = await this.prisma.project.create({
      data: {
        organizationId,
        name,
        slug,
        description: data.description?.trim() || null,
        repositoryUrl: data.repositoryUrl?.trim() || null,
        icon: data.icon?.trim() || null,
        backgroundImage: data.backgroundImage?.trim() || null,
        namespace,
        createdBy: user.id,
        members: adminRole ? {
          create: {
            userId: user.id,
            roleId: adminRole.id,
            addedBy: user.id,
          },
        } : undefined,
      },
      include: {
        organization: true,
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        _count: {
          select: {
            deployments: true,
          },
        },
      },
    });

    // Push the effective ResourceQuota/LimitRange to the new namespace.
    await this.quotasService.applyProjectQuota(project.id).catch((err) => {
      console.error('[Projects] initial applyProjectQuota failed:', err);
    });

    return project;
  }

  async updateDeploymentResources(
    deploymentId: string,
    data: { cpuRequestMilli: number | null; memoryRequestBytes: number | null },
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');

    // Unlimited mode: cpuRequestMilli === 0 means remove all resource constraints.
    const isUnlimited = data.cpuRequestMilli === 0 && data.memoryRequestBytes === 0;

    if (isUnlimited) {
      await this.kubernetesService.removeDeploymentResources(
        deployment.namespace,
        deployment.name,
      );
    } else {
      const resolved = await this.quotasService.resolvePodResources(deployment.projectId, {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes,
      });

      // Org-wide delta check.
      await this.quotasService.enforceOrgCapForNewPod(deployment.project.organizationId, {
        cpuMilli: resolved.cpuMilli * (deployment.replicas || 1),
        memoryBytes: resolved.memoryBytes * (deployment.replicas || 1),
      });

      await this.kubernetesService.updateDeploymentResources(
        deployment.namespace,
        deployment.name,
        resolved,
      );
    }

    return this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
      },
    });
  }

  async updateDatabaseResources(
    databaseId: string,
    data: { cpuRequestMilli: number | null; memoryRequestBytes: number | null },
  ) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: true },
    });
    if (!database) throw new NotFoundException('Database not found');
    if (database.mode !== 'cnpg' || !database.clusterName || !database.namespace) {
      throw new BadRequestException('Database does not support resource updates');
    }

    const resolved = await this.quotasService.resolvePodResources(database.projectId, {
      cpuRequestMilli: data.cpuRequestMilli,
      memoryRequestBytes: data.memoryRequestBytes,
    });
    await this.quotasService.enforceOrgCapForNewPod(database.project.organizationId, {
      cpuMilli: resolved.cpuMilli,
      memoryBytes: resolved.memoryBytes,
    });

    await this.kubernetesService.updateCnpgClusterResources(
      database.namespace,
      database.clusterName,
      resolved,
    );

    return this.prisma.database.update({
      where: { id: databaseId },
      data: {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
      },
    });
  }

  async createDeployment(
    projectId: string,
    data: {
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
      templateInstanceId?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to create deployments');
    }

    const nameInput = String(data.name || '').trim();
    const image = String(data.image || '').trim();
    const replicas = data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;

    if (!nameInput) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!image) {
      throw new BadRequestException('Image is required');
    }

    const name = this.formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException('Deployment name cannot be empty');
    }

    const existingDeployment = await this.prisma.deployment.findUnique({
      where: {
        projectId_name: {
          projectId: project.id,
          name,
        },
      },
    });

    if (existingDeployment) {
      throw new BadRequestException('A deployment with this name already exists in the project');
    }

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, string>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, entry.value);
    }

    const env = Array.from(uniqueEnv.entries()).map(([key, value]) => ({
      key,
      value,
    }));

    const exposePublic = Boolean(data.exposePublic);

    const rawPorts = Array.isArray(data.ports) && data.ports.length > 0
      ? data.ports
      : [
          {
            name: 'http',
            containerPort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            servicePort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            protocol: 'TCP',
          },
        ];

    const volumes = Array.isArray(data.volumes) ? data.volumes : [];

    // Resolve per-pod resources (explicit override → org default → fallback).
    const podResources = await this.quotasService.resolvePodResources(project.id, {
      cpuRequestMilli: data.cpuRequestMilli ?? null,
      memoryRequestBytes: data.memoryRequestBytes ?? null,
    });

    await this.quotasService.enforceOrgCapForNewPod(project.organizationId, {
      cpuMilli: podResources.cpuMilli * replicas,
      memoryBytes: podResources.memoryBytes * replicas,
    });
    // Make sure the namespace ResourceQuota/LimitRange reflect current caps.
    await this.quotasService.applyProjectQuota(project.id).catch((err) => {
      console.error('[Projects] applyProjectQuota failed:', err);
    });

    const placement = await this.resolvePlacementForProject(project.id);
    const deploymentResult = await this.kubernetesService.createDeployment({
      namespace: project.namespace,
      name,
      image,
      replicas,
      ports: rawPorts,
      env,
      serviceType: exposePublic ? 'NodePort' : 'ClusterIP',
      volumes,
      allowedNodes: placement.allowedNodes,
      deniedNodes: placement.deniedNodes,
      resources: podResources,
    });

    let createdDeployment;
    try {
      createdDeployment = await this.prisma.$transaction(async (tx) => {
      const deployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          name,
          namespace: project.namespace,
          image,
          replicas,
          status: 'running',
          createdBy: user.id,
          templateInstanceId: data.templateInstanceId ?? null,
          cpuRequestMilli: data.cpuRequestMilli ?? null,
          memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
        },
      });

      if (env.length > 0) {
        await tx.deploymentEnvVar.createMany({
          data: env.map((entry) => ({
            deploymentId: deployment.id,
            key: entry.key,
            value: entry.value,
          })),
        });
      }

      if (volumes.length > 0) {
        await tx.deploymentVolume.createMany({
          data: volumes.map((vol) => ({
            deploymentId: deployment.id,
            name: vol.name.trim(),
            type: vol.type === 'pvc' ? 'pvc' : vol.type === 'hostPath' ? 'hostPath' : 'emptyDir',
            mountPath: vol.mountPath.trim(),
            pvcName: vol.type === 'pvc' && vol.pvcName ? vol.pvcName.trim() : null,
            storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
            hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
            readOnly: Boolean(vol.readOnly),
          })),
        });
      }

      const normalizedPorts = deploymentResult.ports || [];
      const primaryPort = normalizedPorts[0] || {
        name: 'http',
        containerPort: 80,
        servicePort: 80,
        protocol: 'TCP',
        nodePort: null,
      };
      const primaryNodePort =
        primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
          ? primaryPort.nodePort
          : null;

      const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;
      const externalIp = deploymentResult.externalIp || null;

      const service = await tx.service.create({
        data: {
          deploymentId: deployment.id,
          name,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          externalIp,
          nodePort: primaryNodePort,
        },
      });

      if (normalizedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: normalizedPorts.map((portEntry) => ({
            serviceId: service.id,
            name: portEntry.name,
            port: portEntry.servicePort,
            targetPort: portEntry.containerPort,
            protocol: portEntry.protocol,
            nodePort:
              portEntry.nodePort !== undefined && portEntry.nodePort !== null
                ? portEntry.nodePort
                : null,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          volumes: true,
          ingresses: {
            include: {
              service: true,
            },
          },
          project: {
            include: {
              organization: true,
            },
          },
        },
      });
      });
    } catch (e) {
      try { await this.kubernetesService.deleteDeployment(name, project.namespace); } catch { /* ignore */ }
      try { await this.kubernetesService.deleteService(project.namespace, name); } catch { /* ignore */ }
      throw e;
    }

    return createdDeployment;
  }

  async createDeploymentFromGitHub(
    projectId: string,
    data: {
      name: string;
      repoUrl: string;
      branch: string;
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
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to create deployments');
    }

    const nameInput = String(data.name || '').trim();
    const replicas = data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;
    let repoUrl = String(data.repoUrl || data['githubRepo'] || '').trim();
    // Accept owner/repo shorthand and convert to full URL
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    const branch = String(data.branch || 'main').trim();
    const dockerfilePath = String(data.dockerfilePath || '').trim();
    const tag = data.tag ? String(data.tag).trim() : 'latest';
    const buildType = data.buildType === 'railpack' ? 'railpack' : 'dockerfile';

    if (!nameInput) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!repoUrl) {
      throw new BadRequestException('Repository URL is required');
    }

    if (!branch) {
      throw new BadRequestException('Branch is required');
    }

    // Dockerfile path is only required for dockerfile builds
    if (buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }

    const name = this.formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException('Deployment name cannot be empty');
    }

    const existingDeployment = await this.prisma.deployment.findUnique({
      where: {
        projectId_name: {
          projectId: project.id,
          name,
        },
      },
    });

    if (existingDeployment) {
      throw new BadRequestException('A deployment with this name already exists in the project');
    }

    const imageName = `${project.namespace}-${name}`;
    
    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;
    
    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, string>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, entry.value);
    }

    const env = Array.from(uniqueEnv.entries()).map(([key, value]) => ({
      key,
      value,
    }));

    const exposePublic = Boolean(data.exposePublic);

    // Auto-detect port from Dockerfile EXPOSE directive if no port specified
    let detectedPort: number | null = null;
    const hasExplicitPort = (data.port && Number.isInteger(data.port) && data.port > 0) ||
      (Array.isArray(data.ports) && data.ports.length > 0);

    if (!hasExplicitPort && repoUrl && dockerfilePath) {
      try {
        const repoInfo = this.githubService.parseRepoUrl(repoUrl);
        if (repoInfo && user.githubAccessToken) {
          const dockerfileContent = await this.githubService.getFileContent(
            user.githubAccessToken,
            repoInfo.owner,
            repoInfo.repo,
            dockerfilePath,
            branch,
          );
          detectedPort = this.githubService.parseExposedPort(dockerfileContent);
          if (detectedPort) {
            console.log(`[Projects] Auto-detected EXPOSE port ${detectedPort} from ${dockerfilePath}`);
          }
        }
      } catch (error) {
        console.warn(`[Projects] Failed to auto-detect port from Dockerfile:`, error.message);
      }
    }

    const defaultPort = detectedPort || 80;

    const rawPorts = Array.isArray(data.ports) && data.ports.length > 0
      ? data.ports
      : [
          {
            name: 'http',
            containerPort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
            servicePort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
            protocol: 'TCP',
          },
        ];

    // Create deployment record with buildStatus='building' and status='pending'
    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        name,
        namespace: project.namespace,
        image: `${this.dockerService.getImagePath(imageName, uniqueTag)}`, // Placeholder, will be updated
        replicas,
        status: 'pending',
        buildStatus: 'building',
        buildType,
        githubRepo: repoUrl,
        githubBranch: branch,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        buildFromRoot: data.buildFromRoot ?? false,
        buildWithDepot: data.buildWithDepot ?? false,
        createdBy: user.id,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build for ${repoUrl}@${branch}\n`,
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
      },
    });

    // Add environment variables
    if (env.length > 0) {
      await this.prisma.deploymentEnvVar.createMany({
        data: env.map((entry) => ({
          deploymentId: deployment.id,
          key: entry.key,
          value: entry.value,
        })),
      });
    }

    // Add volumes
    const volumes = Array.isArray(data.volumes) ? data.volumes : [];
    if (volumes.length > 0) {
      await this.prisma.deploymentVolume.createMany({
        data: volumes.map((vol) => ({
          deploymentId: deployment.id,
          name: vol.name.trim(),
          type: vol.type === 'pvc' ? 'pvc' : vol.type === 'hostPath' ? 'hostPath' : 'emptyDir',
          mountPath: vol.mountPath.trim(),
          pvcName: vol.type === 'pvc' && vol.pvcName ? vol.pvcName.trim() : null,
          storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
          hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
          readOnly: Boolean(vol.readOnly),
        })),
      });
    }

    console.log(`[Projects] Created deployment record ${deployment.id}, starting async build`);
    
    // Start build process asynchronously - don't await!
    this.buildAndDeployAsync(
      deployment.id,
      {
        repoUrl,
        branch,
        dockerfilePath,
        target: data.target,
        buildFromRoot: data.buildFromRoot,
        buildWithDepot: data.buildWithDepot,
        buildType,
        imageName,
        tag: uniqueTag,
        namespace: project.namespace,
        name,
        replicas,
        rawPorts,
        env,
        exposePublic,
        volumes,
        isRebuild: false,
        triggerType: 'manual',
        triggeredById: user.id,
      },
      user.githubAccessToken,
    ).catch((error) => {
      console.error(`[Projects] Async build failed for deployment ${deployment.id}:`, error);
    });

    // Return deployment immediately so frontend can poll for logs
    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  private async getDeploymentProgressUrl(deploymentId: string): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { project: { select: { organization: { select: { slug: true } } } } },
    });
    const orgSlug = deployment?.project?.organization?.slug;
    return orgSlug
      ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
      : `${frontendUrl}/deployments/${deploymentId}/progress`;
  }

  private async buildAndDeployAsync(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
      target?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      imageName: string;
      tag: string;
      namespace: string;
      name: string;
      replicas: number;
      rawPorts: any[];
      env: any[];
      exposePublic: boolean;
      volumes?: any[];
      isRebuild?: boolean;
      // GitHub Deployments API support (legacy)
      commitSha?: string;
      commitMessage?: string;
      commitAuthorName?: string;
      commitAuthorUsername?: string;
      githubDeploymentId?: number | null;
      githubAccessToken?: string | null;
      repoInfo?: { owner: string; repo: string } | null;
      // GitHub Checks API support (new - via App)
      checkRunId?: number | null;
      installationId?: string | null;
      // Build trigger info
      triggerType?: string;
      triggeredById?: string;
    },
    githubAccessToken?: string,
  ) {
    console.log(`[Projects] Starting buildAndDeployAsync for deployment ${deploymentId}`);
    
    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.warn(`[Projects] Failed to cancel existing build jobs:`, error);
    }

    // Set up periodic log updates to GitHub Check Run
    let logUpdateInterval: NodeJS.Timeout | null = null;
    let lastLogLength = 0;

    if (data.checkRunId && data.installationId && data.repoInfo) {
      logUpdateInterval = setInterval(async () => {
        try {
          const currentDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildLogs: true, buildStep: true },
          });

          const currentLogs = currentDeployment?.buildLogs || '';

          // Only update if logs have changed
          if (currentLogs.length > lastLogLength) {
            lastLogLength = currentLogs.length;

            const stepLabel = currentDeployment?.buildStep === 'cloning' ? 'Cloning repository...' :
                             currentDeployment?.buildStep === 'building' ? 'Building image...' :
                             currentDeployment?.buildStep === 'pushing' ? 'Pushing to registry...' :
                             currentDeployment?.buildStep === 'deploying' ? 'Deploying to cluster...' :
                             'Building...';

            await this.githubService.updateCheckRun(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              data.checkRunId,
              {
                status: 'in_progress',
                output: {
                  title: stepLabel,
                  summary: `Deploying \`${data.name}\` from commit \`${data.commitSha?.substring(0, 7) || 'unknown'}\``,
                  text: this.githubService.formatLogsForCheck(currentLogs),
                },
              }
            );
          }
        } catch (err) {
          // Don't fail the build if log updates fail
          console.error(`[Projects] Failed to update check run logs: ${err.message}`);
        }
      }, 10000); // Update every 10 seconds
    }

    try {
      const buildTypeLabel = data.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
      console.log(`[Projects] Building image from GitHub using ${buildTypeLabel}: ${data.repoUrl}@${data.branch} -> ${data.imageName}:${data.tag}${data.target ? ` (target: ${data.target})` : ''}`, {
        deploymentId,
        dockerfilePath: data.dockerfilePath,
        buildFromRoot: data.buildFromRoot,
        hasAccessToken: !!githubAccessToken,
        isRebuild: data.isRebuild,
      });

      const buildStartTime = Date.now();
      
      const image = await this.dockerService.buildAndPushFromGitHub({
        repoUrl: data.repoUrl,
        branch: data.branch,
        dockerfilePath: data.dockerfilePath || 'Dockerfile',
        target: data.target,
        buildFromRoot: data.buildFromRoot,
        buildWithDepot: data.buildWithDepot,
        buildType: data.buildType,
        imageName: data.imageName,
        tag: data.tag,
        deploymentId,
        accessToken: githubAccessToken,
      });

      const buildCompletedAt = new Date();
      const buildDuration = Math.floor((buildCompletedAt.getTime() - buildStartTime) / 1000);
      console.log(`[Projects] Built and pushed image: ${image}, ${data.isRebuild ? 'updating' : 'creating'} Kubernetes resources (build took ${buildDuration}s)`);

      // Update deployment with final image
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { image },
      });

      // Save image history and enforce max 10 images per deployment
      await this.prisma.$transaction(async (tx) => {
        // Mark all previous images as inactive
        await tx.imageHistory.updateMany({
          where: { deploymentId, isActive: true },
          data: { isActive: false },
        });

        // Create new image history entry
        const deployment = await tx.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true },
        });

        await tx.imageHistory.create({
          data: {
            deploymentId,
            image,
            tag: data.tag,
            commitSha: data.commitSha || null,
            commitMessage: data.commitMessage || null,
            commitAuthorName: data.commitAuthorName || null,
            commitAuthorUsername: data.commitAuthorUsername || null,
            branch: data.branch,
            buildLogs: deployment?.buildLogs || null,
            buildStartedAt: new Date(buildStartTime),
            buildCompletedAt,
            triggerType: data.triggerType || null,
            triggeredById: data.triggeredById || null,
            isActive: true,
          },
        });

        // Remove oldest images if we exceed max 10
        const allImages = await tx.imageHistory.findMany({
          where: { deploymentId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, image: true },
        });

        if (allImages.length > 10) {
          const imagesToRemove = allImages.slice(10);
          const idsToRemove = imagesToRemove.map((img) => img.id);

          await tx.imageHistory.deleteMany({
            where: { id: { in: idsToRemove } },
          });

          // Delete old artifact tags from the registry in the background
          const imageRefs = imagesToRemove.map((img) => img.image);
          this.dockerService.deleteArtifactsFromRegistry(imageRefs).catch((err) => {
            console.error(`[Projects] Failed to delete old artifacts from registry:`, err);
          });
        }
      });

      let deploymentResult: any;

      // Set buildStep to deploying
      const currentDeploymentData = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true, buildStepTimestamps: true } });
      const currentLogs = currentDeploymentData?.buildLogs || '';
      const currentTimestamps = (currentDeploymentData?.buildStepTimestamps as Record<string, number> | null) || {};
      currentTimestamps['deploying'] = Date.now();
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          buildStep: 'deploying',
          buildLogs: currentLogs + '[INFO] Creating Kubernetes deployment...\n',
          buildStepTimestamps: currentTimestamps,
        },
      });

      // Resolve node placement rules for this deployment's org once.
      const deploymentRow = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          projectId: true,
          replicas: true,
          cpuRequestMilli: true,
          memoryRequestBytes: true,
          project: { select: { organizationId: true } },
        },
      });
      const deployPlacement = deploymentRow
        ? await this.resolvePlacementForProject(deploymentRow.projectId)
        : { allowedNodes: null as string[] | null, deniedNodes: [] as string[] };

      let rebuildResources: { cpuMilli: number; memoryBytes: number } | undefined;
      const isUnlimitedDeploy = deploymentRow?.cpuRequestMilli === 0 &&
        (deploymentRow?.memoryRequestBytes === BigInt(0) || deploymentRow?.memoryRequestBytes === null);
      if (deploymentRow && !isUnlimitedDeploy) {
        rebuildResources = await this.quotasService.resolvePodResources(deploymentRow.projectId, {
          cpuRequestMilli: deploymentRow.cpuRequestMilli,
          memoryRequestBytes: deploymentRow.memoryRequestBytes ? Number(deploymentRow.memoryRequestBytes) : null,
        });
        await this.quotasService.enforceOrgCapForNewPod(deploymentRow.project.organizationId, {
          cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
          memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1),
        });
        await this.quotasService.applyProjectQuota(deploymentRow.projectId).catch((err) => {
          console.error('[Projects] applyProjectQuota failed:', err);
        });
      }

      let shouldCreateNew = false;
      if (data.isRebuild) {
        // Check if Kubernetes deployment actually exists
        const existingDeploymentDb = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          include: { services: { include: { ports: true } } },
        });

        // Check if Kubernetes deployment actually exists in the cluster
        let k8sDeploymentExists = false;
        try {
          const k8sDeployment = await this.kubernetesService.getKubernetesDeployment(data.name, data.namespace);
          k8sDeploymentExists = k8sDeployment !== null;
        } catch (error) {
          // If we can't check, assume it doesn't exist
          k8sDeploymentExists = false;
        }

        // If no services exist in database OR Kubernetes deployment doesn't exist, create it
        const hasServices = existingDeploymentDb?.services && existingDeploymentDb.services.length > 0;
        if (!hasServices || !k8sDeploymentExists) {
          shouldCreateNew = true;
        }

        if (shouldCreateNew) {
          // Kubernetes deployment doesn't exist, create it as new
          deploymentResult = await this.kubernetesService.createDeployment({
            namespace: data.namespace,
            name: data.name,
            image,
            replicas: data.replicas,
            ports: data.rawPorts,
            env: data.env,
            serviceType: data.exposePublic ? 'NodePort' : 'ClusterIP',
            volumes: data.volumes || [],
            allowedNodes: deployPlacement.allowedNodes,
            deniedNodes: deployPlacement.deniedNodes,
            resources: rebuildResources,
          });
        } else {
          // Update existing Kubernetes deployment with new image
          await this.kubernetesService.updateDeploymentImage(
            data.name,
            data.namespace,
            image,
          );

          // Fetch existing service info for the response
          deploymentResult = {
            ports: existingDeploymentDb?.services[0]?.ports || [],
            externalIp: existingDeploymentDb?.services[0]?.externalIp || null,
          };
        }
      } else {
        // Create new Kubernetes deployment
        deploymentResult = await this.kubernetesService.createDeployment({
          namespace: data.namespace,
          name: data.name,
          image,
          replicas: data.replicas,
          ports: data.rawPorts,
          env: data.env,
          serviceType: data.exposePublic ? 'NodePort' : 'ClusterIP',
          volumes: data.volumes || [],
        });
      }

      if (!data.isRebuild || shouldCreateNew) {
        // Only create service and ports for new deployments or rebuilds where deployment didn't exist
        await this.prisma.$transaction(async (tx) => {
          // Check if services already exist (might exist from previous failed attempt)
          const existingDeployment = await tx.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } },
          });

          const hasServices = existingDeployment?.services && existingDeployment.services.length > 0;

          if (!hasServices) {
            // Create services and ports if they don't exist
            const normalizedPorts = deploymentResult.ports || [];
            const primaryPort = normalizedPorts[0] || {
              name: 'http',
              containerPort: 80,
              servicePort: 80,
              protocol: 'TCP',
              nodePort: null,
            };
            const primaryNodePort =
              primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
                ? primaryPort.nodePort
                : null;

            const serviceType = data.exposePublic ? ServiceType.external : ServiceType.internal;
            const externalIp = deploymentResult.externalIp || null;

            const service = await tx.service.create({
              data: {
                deploymentId,
                name: data.name,
                type: serviceType,
                port: primaryPort.servicePort,
                targetPort: primaryPort.containerPort,
                protocol: primaryPort.protocol,
                externalIp,
                nodePort: primaryNodePort,
              },
            });

            if (normalizedPorts.length > 0) {
              await tx.servicePort.createMany({
                data: normalizedPorts.map((portEntry) => ({
                  serviceId: service.id,
                  name: portEntry.name,
                  port: portEntry.servicePort,
                  targetPort: portEntry.containerPort,
                  protocol: portEntry.protocol,
                  nodePort:
                    portEntry.nodePort !== undefined && portEntry.nodePort !== null
                      ? portEntry.nodePort
                      : null,
                })),
              });
            }
          }

          // Update deployment status to success
          const txDeployData = await tx.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true, buildStepTimestamps: true } });
          const txTimestamps = (txDeployData?.buildStepTimestamps as Record<string, number> | null) || {};
          txTimestamps['complete'] = Date.now();
          await tx.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'running',
              buildStatus: 'succeeded',
              buildStep: 'complete',
              buildLogs: (txDeployData?.buildLogs || '') + '\nDeployment is live.',
              buildStepTimestamps: txTimestamps,
            },
          });
        });
      } else {
        // For rebuilds where deployment already existed, just update the status
        const rebuildData = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true, buildStepTimestamps: true } });
        const rebuildTimestamps = (rebuildData?.buildStepTimestamps as Record<string, number> | null) || {};
        rebuildTimestamps['complete'] = Date.now();
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'running',
            buildStatus: 'succeeded',
            buildStep: 'complete',
            buildLogs: (rebuildData?.buildLogs || '') + '\nRebuild complete. Deployment is live.',
            buildStepTimestamps: rebuildTimestamps,
          },
        });
      }

      console.log(`[Projects] Deployment ${deploymentId} completed successfully`);

      // Update GitHub deployment status to success
      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

          // Get the environment URL from ingresses if available
          const deploymentWithIngress = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { ingresses: true },
          });
          const environmentUrl = deploymentWithIngress?.ingresses?.[0]?.host
            ? `https://${deploymentWithIngress.ingresses[0].host}`
            : undefined;

          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'success',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              environmentUrl,
              description: 'Deployment successful!',
            }
          );

          // Update our record
          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId),
            },
            data: {
              status: 'success',
              environmentUrl,
            },
          });
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${err.message}`);
        }
      }

      // Clear the log update interval
      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      // Update GitHub Check Run to success (via App)
      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          const finalDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildLogs: true, ingresses: { select: { host: true } } },
          });

          const buildLogs = finalDeployment?.buildLogs || '';
          const environmentUrl = finalDeployment?.ingresses?.[0]?.host
            ? `https://${finalDeployment.ingresses[0].host}`
            : undefined;

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'success',
              output: {
                title: 'Deployment Successful',
                summary: environmentUrl
                  ? `\`${data.name}\` is live at [${environmentUrl}](${environmentUrl}).`
                  : `\`${data.name}\` deployed successfully.`,
                text: this.githubService.formatLogsForCheck(buildLogs),
              },
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to success`);
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub check run: ${err.message}`);
        }
      }

      // Update GitHub Deployment to success (via App)
      if (data.installationId && data.repoInfo) {
        try {
          // Find the GitHub deployment we created
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' },
          });

          if (ghDeployment) {
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
            const finalDeploymentData = await this.prisma.deployment.findUnique({
              where: { id: deploymentId },
              include: { ingresses: true },
            });
            const environmentUrl = finalDeploymentData?.ingresses?.[0]?.host
              ? `https://${finalDeploymentData.ingresses[0].host}`
              : undefined;

            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'success',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                environmentUrl,
                description: 'Deployment successful!',
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'success', environmentUrl },
            });

            console.log(`[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to success`);
          }
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment: ${err.message}`);
        }
      }
    } catch (error) {
      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      const errorDetails = {
        deploymentId,
        imageName: data.imageName,
        tag: data.tag,
        repoUrl: data.repoUrl,
        branch: data.branch,
        buildType: data.buildType,
        errorMessage: error.message,
        errorType: error.constructor.name,
        errorStack: error.stack,
        statusCode: error.statusCode || error.status,
        response: error.response,
        isRebuild: data.isRebuild,
      };

      console.error(`[Projects] Build failed for deployment ${deploymentId}:`, errorDetails);

      try {
        const currentDeployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true, buildStep: true, status: true, buildStatus: true },
        });

        // Don't overwrite a successful build status from a newer build
        if (currentDeployment?.buildStatus === 'succeeded') {
          console.log(`[Projects] Deployment ${deploymentId} already has a succeeded build (likely from a newer build), skipping error status update`);
          return;
        }

        const errorLogEntry = `\n❌ Build failed at step '${currentDeployment?.buildStep || 'unknown'}'\nError: ${error.message}\nError Type: ${error.constructor.name}\n`;

        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            buildStatus: 'failed',
            buildError: error.message,
            buildLogs: (currentDeployment?.buildLogs || '') + errorLogEntry,
          },
        });
      } catch (dbErr) {
        console.error(`[Projects] Failed to update error status in database:`, {
          deploymentId,
          dbError: dbErr.message,
          originalError: error.message,
        });
      }

      // Update GitHub deployment status to failure (legacy - user token)
      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'failure',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              description: `Build failed: ${error.message?.substring(0, 100)}`,
            }
          );

          // Update our record
          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId),
            },
            data: {
              status: 'failure',
            },
          });
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${ghErr.message}`);
        }
      }

      // Update GitHub Deployment to failure (via App)
      if (data.installationId && data.repoInfo) {
        try {
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' },
          });

          if (ghDeployment) {
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'failure',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                description: `Build failed: ${error.message?.substring(0, 100)}`,
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'failure' },
            });

            console.log(`[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to failure`);
          }
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment: ${ghErr.message}`);
        }
      }

      // Update GitHub Check Run to failure (via App)
      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          const failedDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildLogs: true },
          });

          const buildLogs = failedDeployment?.buildLogs || '';

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'failure',
              output: {
                title: 'Deployment Failed',
                summary: `❌ Failed to deploy \`${data.name}\`: ${error.message?.substring(0, 200) || 'Unknown error'}`,
                text: this.githubService.formatLogsForCheck(buildLogs),
              },
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to failure`);
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub check run: ${ghErr.message}`);
        }
      }
    }
  }

  async rebuildDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    // For dockerfile builds, dockerfilePath is required
    if (deployment.buildType === 'dockerfile' && !deployment.dockerfilePath) {
      throw new BadRequestException('Dockerfile path is missing for this deployment');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to rebuild deployments');
    }

    if (deployment.buildStatus === 'building') {
      throw new BadRequestException('A build is already in progress for this deployment. Please cancel it before starting a new build.');
    }

    console.log(`[Projects] Cancelling any existing build jobs for deployment ${deploymentId}`);
    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.error(`[Projects] Error cancelling existing build jobs:`, error);
    }

    // Reset build status to building
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStep: null,
        buildStepTimestamps: {},
        buildLogs: `🔄 Rebuilding deployment from ${deployment.githubRepo}@${deployment.githubBranch}\n`,
        buildError: null,
      },
    });

    // Extract image name from current image
    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag = imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;

    // Get service configuration
    const service = deployment.services[0];
    const rawPorts = service?.ports.map(port => ({
      name: port.name,
      containerPort: port.targetPort,
      servicePort: port.port,
      protocol: port.protocol,
      nodePort: port.nodePort || undefined,
    })) || [];

    const env = deployment.envVars.map(ev => ({
      key: ev.key,
      value: ev.value,
    }));

    const volumes = (deployment.volumes || []).map(vol => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly,
    }));

    // Start rebuild process asynchronously
    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildWithDepot: deployment.buildWithDepot ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        triggerType: 'manual',
        triggeredById: user.id,
      },
      user.githubAccessToken,
    ).catch((error) => {
      console.error(`[Projects] Rebuild failed for deployment ${deploymentId}:`, error);
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async getImageHistory(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    return this.prisma.imageHistory.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getImageHistoryLogs(deploymentId: string, imageHistoryId: string) {
    const entry = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId },
      select: { deploymentId: true, buildLogs: true },
    });

    if (!entry || entry.deploymentId !== deploymentId) {
      throw new NotFoundException(`Image history entry not found`);
    }

    return { logs: entry.buildLogs || '' };
  }

  async rollbackToImage(
    deploymentId: string,
    imageHistoryId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to rollback deployments');
    }

    const imageHistory = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId },
    });

    if (!imageHistory || imageHistory.deploymentId !== deploymentId) {
      throw new NotFoundException('Image history not found');
    }

    // Update Kubernetes deployment with the old image
    await this.kubernetesService.updateDeploymentImage(
      deployment.name,
      deployment.namespace,
      imageHistory.image,
    );

    // Update database
    await this.prisma.$transaction(async (tx) => {
      // Mark all images as inactive
      await tx.imageHistory.updateMany({
        where: { deploymentId },
        data: { isActive: false },
      });

      // Mark this image as active
      await tx.imageHistory.update({
        where: { id: imageHistoryId },
        data: { isActive: true },
      });

      // Update deployment
      await tx.deployment.update({
        where: { id: deploymentId },
        data: {
          image: imageHistory.image,
          status: 'running',
        },
      });
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async validateIngressDns(domain: string): Promise<{ valid: boolean; message: string }> {
    const expectedCname = 'ingress.lfdl.ink';
    const domainToCheck = domain.trim().toLowerCase();

    if (!domainToCheck) {
      return { valid: false, message: 'Domain is required' };
    }

    if (domainToCheck.endsWith('.a.lfdl.ink')) {
      return { valid: true, message: 'Auto-generated domain is ready to use' };
    }

    try {
      const resolveCname = promisify(dns.resolveCname);
      const records = await resolveCname(domainToCheck);

      const normalizedExpected = expectedCname.toLowerCase().replace(/\.$/, '');
      const hasValidCname = records.some((record) => {
        const normalizedRecord = record.toLowerCase().replace(/\.$/, '');
        return normalizedRecord === normalizedExpected || normalizedRecord.endsWith('.' + normalizedExpected);
      });

      if (hasValidCname) {
        return { valid: true, message: 'CNAME record is correctly configured' };
      } else {
        return {
          valid: false,
          message: `CNAME record does not point to ${expectedCname}. Found: ${records.join(', ') || 'none'}. Please create a CNAME record pointing ${domainToCheck} to ${expectedCname}`
        };
      }
    } catch (error: any) {
      if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
        return {
          valid: false,
          message: `CNAME record not found. Please create a CNAME record pointing ${domainToCheck} to ${expectedCname}`
        };
      }
      return {
        valid: false,
        message: `DNS lookup failed: ${error.message || 'Unknown error'}`
      };
    }
  }

  async createDeploymentIngress(
    deploymentId: string,
    data: {
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
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        services: {
          include: {
            ports: true,
          },
        },
        ingresses: true,
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const rawHost = String(data.host || '').trim().toLowerCase();

    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }

    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }

    const hostPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    const routesInput = Array.isArray(data.routes) ? data.routes : [];
    const useMultiRoute = routesInput.length >= 2;

    if (useMultiRoute) {
      return this.createDeploymentIngressMultiRoute(
        deploymentId,
        { ...data, host: rawHost, routes: routesInput },
        clerkId,
        userData
      );
    }

    let path: string;
    let requestedServiceName: string;
    let requestedPort: number | null;

    if (routesInput.length === 1) {
      const r = routesInput[0];
      path = String(r.path || '/').trim() || '/';
      if (!path.startsWith('/')) path = `/${path}`;
      requestedServiceName = String(r.serviceName || '').trim();
      requestedPort = Number(r.servicePort);
    } else {
      path = String(data.path || '/').trim();
      if (!path) path = '/';
      if (!path.startsWith('/')) path = `/${path}`;
      requestedServiceName = String(data.serviceName || '').trim();
      requestedPort = data.servicePort !== undefined && data.servicePort !== null ? Number(data.servicePort) : null;
    }

    if (path.length > 255) {
      throw new BadRequestException('Path exceeds maximum length');
    }
    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    if (!pathPattern.test(path)) {
      throw new BadRequestException('Path contains invalid characters');
    }

    const duplicate = deployment.ingresses.find(
      (entry) => entry.host === rawHost && entry.path === path
    );

    if (duplicate) {
      throw new BadRequestException('An ingress for this host and path already exists');
    }

    const ingressClassName = 'traefik';

    const tlsEnabled = data.tlsEnabled !== false;
    let tlsSecretName: string | null = null;
    if (tlsEnabled) {
      tlsSecretName = `leaf-cert-${randomUUID()}`;
      if (tlsSecretName.length > 255) {
        throw new BadRequestException('TLS secret name is too long');
      }
    }

    const clusterIssuer = tlsEnabled ? 'letsencrypt-prod' : null;

    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const annotationsInput =
      data.annotations && typeof data.annotations === 'object'
        ? data.annotations
        : {};

    const sanitizedAnnotations: Record<string, string> = {};

    for (const [key, value] of Object.entries(annotationsInput)) {
      if (value === undefined || value === null) {
        continue;
      }

      const trimmedKey = String(key || '').trim();
      if (!trimmedKey) {
        continue;
      }

      const stringValue = String(value);
      sanitizedAnnotations[trimmedKey] = stringValue;
    }

    sanitizedAnnotations['traefik.ingress.kubernetes.io/router.entrypoints'] =
      entrypoints.join(',');

    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const services = Array.isArray(deployment.services)
      ? deployment.services
      : [];

    if (services.length === 0) {
      throw new BadRequestException('Deployment has no services to attach');
    }

    if (requestedPort !== null) {
      if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
        throw new BadRequestException('Service port must be a positive integer');
      }
    }

    let targetService =
      requestedServiceName.length > 0
        ? services.find((service) => service.name === requestedServiceName)
        : null;

    if (requestedServiceName.length > 0 && !targetService) {
      throw new BadRequestException('Selected service was not found');
    }

    if (!targetService) {
      if (requestedPort !== null) {
        targetService = services.find((service) => {
          const ports = Array.isArray((service as any).ports)
            ? (service as any).ports
            : [];
          if (ports.some((port) => port.port === requestedPort)) {
            return true;
          }
          if (Number(service.port) === requestedPort) {
            return true;
          }
          return false;
        });
      }
    }

    if (!targetService) {
      targetService = services[0];
    }

    const servicePorts = Array.isArray((targetService as any).ports)
      ? (targetService as any).ports
      : [];

    let selectedPort = null as
      | {
          port: number;
          targetPort: number;
        }
      | null;

    if (requestedPort !== null) {
      selectedPort =
        servicePorts.find((port) => Number(port.port) === requestedPort) ||
        null;
      if (!selectedPort && Number(targetService.port) === requestedPort) {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null &&
            targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port),
        };
      }
    }

    if (!selectedPort) {
      if (servicePorts.length > 0) {
        const firstPort = servicePorts[0];
        selectedPort = {
          port: Number(firstPort.port),
          targetPort:
            firstPort.targetPort !== null &&
            firstPort.targetPort !== undefined
              ? Number(firstPort.targetPort)
              : Number(firstPort.port),
        };
      } else {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null &&
            targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port),
        };
      }
    }

    if (
      !Number.isInteger(selectedPort.port) ||
      selectedPort.port <= 0 ||
      !Number.isInteger(selectedPort.targetPort) ||
      selectedPort.targetPort <= 0
    ) {
      throw new BadRequestException('Resolved service port is invalid');
    }

    const hostSlug = rawHost
      .split('.')
      .map((segment) => this.formatSlug(segment))
      .filter((segment) => segment.length > 0)
      .join('-');
    const pathSlug =
      path !== '/'
        ? this.formatSlug(path.replace(/\//g, '-'))
        : '';

    const nameSource = [deployment.name, hostSlug, pathSlug]
      .filter((segment) => segment.length > 0)
      .join('-');

    let baseName = this.formatSlug(nameSource);
    if (!baseName) {
      baseName = this.formatSlug(`${deployment.name}-ingress`);
    }
    if (!baseName) {
      baseName = `ingress-${Math.floor(Date.now() / 1000)}`;
    }

    baseName = baseName.substring(0, 48) || `ingress-${Math.floor(Date.now() / 1000)}`;

    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: {
          namespace: deployment.namespace,
          name: ingressName,
        },
      });

      if (!existing) {
        break;
      }

      ingressName = `${baseName}-${suffixCounter++}`;
      ingressName = ingressName.substring(0, 63);

      if (!ingressName) {
        ingressName = `${baseName.substring(0, 40)}-${suffixCounter}`;
      }

      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    const tlsHosts = tlsSecretName ? [rawHost] : [];

    const ingressResult = await this.kubernetesService.createIngress({
      namespace: deployment.namespace,
      name: ingressName,
      host: rawHost,
      path,
      pathType: 'Prefix',
      serviceName: targetService.name,
      servicePort: selectedPort.port,
      serviceTargetPort: selectedPort.targetPort,
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName,
      entrypoints,
      annotations: sanitizedAnnotations,
      basicAuth: data.basicAuth?.enabled ? data.basicAuth : undefined,
    });

    const statusRecord = Array.isArray(
      ingressResult.status?.loadBalancer?.ingress
    )
      ? ingressResult.status?.loadBalancer?.ingress?.[0] || null
      : null;

    const statusAddress =
      statusRecord?.ip || statusRecord?.hostname || null;

    const annotationsPayload =
      Object.keys(sanitizedAnnotations).length > 0
        ? (sanitizedAnnotations as Prisma.JsonObject)
        : undefined;

    await this.prisma.ingress.create({
      data: {
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        serviceId: targetService.id,
        name: ingressName,
        namespace: deployment.namespace,
        host: rawHost,
        path,
        pathType: 'Prefix',
        tlsSecretName,
        tlsHosts,
        ingressClass: ingressClassName,
        entrypoints,
        clusterIssuer,
        annotations: annotationsPayload,
        statusAddress,
      },
    });

    if (!targetService.domain) {
      await this.prisma.service.update({
        where: { id: targetService.id },
        data: {
          domain: rawHost,
        },
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  private async createDeploymentIngressMultiRoute(
    deploymentId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      routes: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: { include: { organization: true } },
        services: { include: { ports: true } },
        ingresses: true,
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }
    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const rawHost = data.host;
    const services = Array.isArray(deployment.services) ? deployment.services : [];

    if (services.length === 0) {
      throw new BadRequestException('Deployment has no services to attach');
    }

    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    const pathBackends: Array<{ path: string; pathType: string; serviceName: string; servicePort: number }> = [];

    for (const route of data.routes) {
      let path = String(route.path || '/').trim() || '/';
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      if (path.length > 255) {
        throw new BadRequestException(`Path ${path} exceeds maximum length`);
      }
      if (!pathPattern.test(path)) {
        throw new BadRequestException(`Path ${path} contains invalid characters`);
      }

      const existing = deployment.ingresses.find((e) => e.host === rawHost && e.path === path);
      if (existing) {
        throw new BadRequestException(`An ingress for ${rawHost}${path} already exists`);
      }

      const targetService = services.find((s) => s.name === String(route.serviceName || '').trim());
      if (!targetService) {
        throw new BadRequestException(`Service ${route.serviceName} not found in deployment`);
      }

      const port = Number(route.servicePort);
      if (!Number.isInteger(port) || port <= 0) {
        throw new BadRequestException(`Invalid service port for ${route.serviceName}`);
      }

      const servicePorts = Array.isArray((targetService as any).ports) ? (targetService as any).ports : [];
      const hasPort = servicePorts.some((p: any) => Number(p.port) === port) || Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port,
      });
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const tlsSecretName = tlsEnabled ? `leaf-cert-${randomUUID()}` : null;
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (data.annotations && typeof data.annotations === 'object') {
      for (const [key, value] of Object.entries(data.annotations)) {
        if (value != null) {
          sanitizedAnnotations[String(key).trim()] = String(value);
        }
      }
    }
    sanitizedAnnotations['traefik.ingress.kubernetes.io/router.entrypoints'] = entrypoints.join(',');
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => this.formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    let baseName = this.formatSlug(`${deployment.name}-${hostSlug}`.substring(0, 48)) || `ingress-${Math.floor(Date.now() / 1000)}`;
    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: { namespace: deployment.namespace, name: ingressName },
      });
      if (!existing) break;
      ingressName = `${baseName}-${suffixCounter++}`.substring(0, 63);
      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    const ingressResult = await this.kubernetesService.createIngress({
      namespace: deployment.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends,
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: 'traefik',
      entrypoints,
      annotations: sanitizedAnnotations,
      basicAuth: data.basicAuth?.enabled ? data.basicAuth : undefined,
    });

    const statusRecord = Array.isArray(ingressResult.status?.loadBalancer?.ingress)
      ? ingressResult.status?.loadBalancer?.ingress?.[0] || null
      : null;
    const statusAddress = statusRecord?.ip || statusRecord?.hostname || null;

    const firstRoute = pathBackends[0];
    const firstService = services.find((s) => s.name === firstRoute.serviceName)!;

    await this.prisma.ingress.create({
      data: {
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        serviceId: firstService.id,
        name: ingressName,
        namespace: deployment.namespace,
        host: rawHost,
        path: firstRoute.path,
        pathType: 'Prefix',
        tlsSecretName,
        tlsHosts,
        ingressClass: 'traefik',
        entrypoints,
        clusterIssuer,
        annotations: Object.keys(sanitizedAnnotations).length > 0 ? (sanitizedAnnotations as Prisma.JsonObject) : undefined,
        statusAddress,
      },
    });

    if (!firstService.domain) {
      await this.prisma.service.update({
        where: { id: firstService.id },
        data: { domain: rawHost },
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        project: { include: { organization: true } },
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async createProjectIngress(
    projectId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      routes: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
      templateInstanceId?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
        deployments: {
          include: {
            services: { include: { ports: true } },
            ingresses: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }
    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const rawHost = String(data.host || '').trim().toLowerCase();
    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }
    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }
    const hostPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    const routes = Array.isArray(data.routes) && data.routes.length > 0 ? data.routes : null;
    if (!routes || routes.length === 0) {
      throw new BadRequestException('At least one route is required');
    }

    const allServices = project.deployments.flatMap((d) => (d.services ?? []).map((s) => ({ ...s, deploymentId: d.id })));
    const allIngresses = project.deployments.flatMap((d) => d.ingresses ?? []);

    if (allServices.length === 0) {
      throw new BadRequestException('Project has no services');
    }

    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    const pathBackends: Array<{ path: string; pathType: string; serviceName: string; servicePort: number; serviceId: string; deploymentId: string }> = [];

    for (const route of routes) {
      let path = String(route.path || '/').trim() || '/';
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      if (path.length > 255) {
        throw new BadRequestException(`Path ${path} exceeds maximum length`);
      }
      if (!pathPattern.test(path)) {
        throw new BadRequestException(`Path ${path} contains invalid characters`);
      }

      const targetService = allServices.find((s) => s.name === String(route.serviceName || '').trim());
      if (!targetService) {
        throw new BadRequestException(`Service ${route.serviceName} not found in project`);
      }

      const port = Number(route.servicePort);
      if (!Number.isInteger(port) || port <= 0) {
        throw new BadRequestException(`Invalid service port for ${route.serviceName}`);
      }

      const servicePorts = Array.isArray((targetService as any).ports) ? (targetService as any).ports : [];
      const hasPort = servicePorts.some((p: any) => Number(p.port) === port) || Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port,
        serviceId: targetService.id,
        deploymentId: (targetService as any).deploymentId,
      });
    }

    const existingForHost = allIngresses.filter((e) => e.host === rawHost);
    const mergeTarget = existingForHost[0] ?? null;

    if (mergeTarget) {
      const k8sIngress = await this.kubernetesService.readIngress(
        mergeTarget.namespace,
        mergeTarget.name
      );
      const existingPaths: Array<{ path: string; pathType: string; serviceName: string; servicePort: number }> =
        (k8sIngress?.spec?.rules?.[0]?.http?.paths ?? []).map((p: any) => ({
          path: p.path || '/',
          pathType: p.pathType || 'Prefix',
          serviceName: p.backend?.service?.name || '',
          servicePort: p.backend?.service?.port?.number || 0,
        }));

      for (const pb of pathBackends) {
        if (existingPaths.some((ep) => ep.path === pb.path)) {
          throw new BadRequestException(
            `Domain ${rawHost} already routes ${pb.path} to another service. Use a different path.`
          );
        }
      }

      const mergedPaths = [...existingPaths, ...pathBackends.map((pb) => ({
        path: pb.path,
        pathType: pb.pathType,
        serviceName: pb.serviceName,
        servicePort: pb.servicePort,
      }))];

      const existingAnnotations = (mergeTarget.annotations as Record<string, string> | null) ?? {};
      const existingEntrypoints = Array.isArray(mergeTarget.entrypoints) ? mergeTarget.entrypoints : [];
      const mergedTlsEnabled = !!mergeTarget.tlsSecretName;

      await this.kubernetesService.updateIngress({
        namespace: mergeTarget.namespace,
        name: mergeTarget.name,
        host: rawHost,
        paths: mergedPaths,
        tlsSecretName: mergeTarget.tlsSecretName || undefined,
        tlsHosts: mergeTarget.tlsHosts ?? (mergedTlsEnabled ? [rawHost] : []),
        ingressClassName: mergeTarget.ingressClass || 'traefik',
        entrypoints: existingEntrypoints,
        annotations: existingAnnotations,
      });

      for (const pb of pathBackends) {
        await this.prisma.ingress.create({
          data: {
            projectId: project.id,
            deploymentId: pb.deploymentId,
            serviceId: pb.serviceId,
            name: mergeTarget.name,
            namespace: mergeTarget.namespace,
            host: rawHost,
            path: pb.path,
            pathType: pb.pathType,
            tlsSecretName: mergeTarget.tlsSecretName,
            tlsHosts: mergeTarget.tlsHosts ?? [],
            ingressClass: mergeTarget.ingressClass || 'traefik',
            entrypoints: existingEntrypoints,
            clusterIssuer: mergeTarget.clusterIssuer,
            annotations: Object.keys(existingAnnotations).length > 0
              ? (existingAnnotations as Prisma.JsonObject)
              : undefined,
            statusAddress: mergeTarget.statusAddress,
            templateInstanceId: data.templateInstanceId ?? null,
          },
        });

        const svc = allServices.find((s) => s.id === pb.serviceId);
        if (svc && !svc.domain) {
          await this.prisma.service.update({
            where: { id: pb.serviceId },
            data: { domain: rawHost },
          });
        }
      }

      return this.getProject(projectId, clerkId, userData);
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const tlsSecretName = tlsEnabled ? `leaf-cert-${randomUUID()}` : null;
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    sanitizedAnnotations['traefik.ingress.kubernetes.io/router.entrypoints'] = entrypoints.join(',');
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => this.formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    let baseName = this.formatSlug(`${project.slug}-${hostSlug}`.substring(0, 48)) || `ingress-${Math.floor(Date.now() / 1000)}`;
    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: { namespace: project.namespace, name: ingressName },
      });
      if (!existing) break;
      ingressName = `${baseName}-${suffixCounter++}`.substring(0, 63);
      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    const ingressResult = await this.kubernetesService.createIngress({
      namespace: project.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends.map((pb) => ({ path: pb.path, pathType: pb.pathType, serviceName: pb.serviceName, servicePort: pb.servicePort })),
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: 'traefik',
      entrypoints,
      annotations: sanitizedAnnotations,
      basicAuth: data.basicAuth?.enabled ? data.basicAuth : undefined,
    });

    const statusRecord = Array.isArray(ingressResult.status?.loadBalancer?.ingress)
      ? ingressResult.status?.loadBalancer?.ingress?.[0] || null
      : null;
    const statusAddress = statusRecord?.ip || statusRecord?.hostname || null;

    try {
      for (const pb of pathBackends) {
        await this.prisma.ingress.create({
          data: {
            projectId: project.id,
            deploymentId: pb.deploymentId,
            serviceId: pb.serviceId,
            name: ingressName,
            namespace: project.namespace,
            host: rawHost,
            path: pb.path,
            pathType: pb.pathType,
            tlsSecretName,
            tlsHosts,
            ingressClass: 'traefik',
            entrypoints,
            clusterIssuer,
            annotations: Object.keys(sanitizedAnnotations).length > 0 ? (sanitizedAnnotations as Prisma.JsonObject) : undefined,
            statusAddress,
            templateInstanceId: data.templateInstanceId ?? null,
          },
        });

        const svc = allServices.find((s) => s.id === pb.serviceId);
        if (svc && !svc.domain) {
          await this.prisma.service.update({
            where: { id: pb.serviceId },
            data: { domain: rawHost },
          });
        }
      }
    } catch (e) {
      try { await this.kubernetesService.deleteIngress(project.namespace, ingressName); } catch { /* ignore */ }
      await this.prisma.ingress.deleteMany({
        where: { namespace: project.namespace, name: ingressName },
      });
      throw e;
    }

    return this.getProject(projectId, clerkId, userData);
  }

  async getIngressById(
    ingressId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        project: {
          include: {
            organization: true,
            deployments: {
              include: {
                services: { include: { ports: true } },
              },
            },
          },
        },
        deployment: true,
        service: true,
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    await this.assertProjectAccess(ingress.project.id, user.id, ingress.project.organizationId);

    // Read the actual K8s ingress to get all routes
    let k8sRoutes: Array<{ path: string; serviceName: string; servicePort: number }> = [];
    try {
      const k8sIngress = await this.kubernetesService.readIngress(ingress.namespace, ingress.name);
      const rules = k8sIngress?.spec?.rules ?? [];
      if (rules.length > 0 && rules[0].http?.paths) {
        k8sRoutes = rules[0].http.paths.map((p: any) => ({
          path: p.path || '/',
          serviceName: p.backend?.service?.name || '',
          servicePort: p.backend?.service?.port?.number || 0,
        }));
      }
    } catch {
      k8sRoutes = [{
        path: ingress.path,
        serviceName: ingress.service?.name || '',
        servicePort: ingress.service?.port || 0,
      }];
    }

    return {
      ...ingress,
      tlsEnabled: !!ingress.tlsSecretName,
      address: ingress.statusAddress,
      routes: k8sRoutes,
    };
  }

  async getProjectIngress(
    projectId: string,
    ingressId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        project: {
          include: {
            organization: true,
            deployments: {
              include: {
                services: { include: { ports: true } },
              },
            },
          },
        },
        service: true,
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    if (ingress.projectId !== projectId) {
      throw new BadRequestException('Ingress does not belong to this project');
    }

    await this.assertProjectAccess(ingress.project.id, user.id, ingress.project.organizationId);

    // Read the actual K8s ingress to get all routes
    let k8sRoutes: Array<{ path: string; serviceName: string; servicePort: number }> = [];
    try {
      const k8sIngress = await this.kubernetesService.readIngress(ingress.namespace, ingress.name);
      const rules = k8sIngress?.spec?.rules ?? [];
      if (rules.length > 0 && rules[0].http?.paths) {
        k8sRoutes = rules[0].http.paths.map((p: any) => ({
          path: p.path || '/',
          serviceName: p.backend?.service?.name || '',
          servicePort: p.backend?.service?.port?.number || 0,
        }));
      }
    } catch (error) {
      // If we can't read K8s, fall back to DB record
      k8sRoutes = [{
        path: ingress.path,
        serviceName: ingress.service?.name || '',
        servicePort: ingress.service?.port || 0,
      }];
    }

    const hasBasicAuth = typeof ingress.annotations === 'object' && ingress.annotations !== null
      && (ingress.annotations as any)['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd');

    return {
      id: ingress.id,
      name: ingress.name,
      host: ingress.host,
      path: ingress.path,
      tlsEnabled: !!ingress.tlsSecretName,
      routes: k8sRoutes,
      basicAuthEnabled: hasBasicAuth,
      project: ingress.project,
    };
  }

  async updateProjectIngress(
    projectId: string,
    ingressId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      routes: Array<{ path: string; serviceName: string; servicePort: number }>;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        project: {
          include: {
            organization: true,
            deployments: {
              include: {
                services: { include: { ports: true } },
                ingresses: true,
              },
            },
          },
        },
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    if (ingress.projectId !== projectId) {
      throw new BadRequestException('Ingress does not belong to this project');
    }

    const project = ingress.project;

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }
    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const rawHost = String(data.host || '').trim().toLowerCase();
    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }
    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }
    const hostPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    const routes = Array.isArray(data.routes) && data.routes.length > 0 ? data.routes : null;
    if (!routes || routes.length === 0) {
      throw new BadRequestException('At least one route is required');
    }

    const allServices = project.deployments.flatMap((d) => (d.services ?? []).map((s) => ({ ...s, deploymentId: d.id })));

    if (allServices.length === 0) {
      throw new BadRequestException('Project has no services');
    }

    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    const pathBackends: Array<{ path: string; pathType: string; serviceName: string; servicePort: number; serviceId: string; deploymentId: string }> = [];

    for (const route of routes) {
      let path = String(route.path || '/').trim() || '/';
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      if (path.length > 255) {
        throw new BadRequestException(`Path ${path} exceeds maximum length`);
      }
      if (!pathPattern.test(path)) {
        throw new BadRequestException(`Path ${path} contains invalid characters`);
      }

      const targetService = allServices.find((s) => s.name === String(route.serviceName || '').trim());
      if (!targetService) {
        throw new BadRequestException(`Service ${route.serviceName} not found in project`);
      }

      const port = Number(route.servicePort);
      if (!Number.isInteger(port) || port <= 0) {
        throw new BadRequestException(`Invalid service port for ${route.serviceName}`);
      }

      const servicePorts = Array.isArray((targetService as any).ports) ? (targetService as any).ports : [];
      const hasPort = servicePorts.some((p: any) => Number(p.port) === port) || Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port,
        serviceId: targetService.id,
        deploymentId: (targetService as any).deploymentId,
      });
    }

    const tlsEnabled = data.tlsEnabled !== false;
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled && !tlsSecretName) {
      tlsSecretName = `leaf-cert-${randomUUID()}`;
    } else if (!tlsEnabled) {
      tlsSecretName = null;
    }
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    sanitizedAnnotations['traefik.ingress.kubernetes.io/router.entrypoints'] = entrypoints.join(',');
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    try {
      await this.kubernetesService.updateIngress({
        namespace: ingress.namespace,
        name: ingress.name,
        host: rawHost,
        paths: pathBackends.map((pb) => ({ path: pb.path, pathType: pb.pathType, serviceName: pb.serviceName, servicePort: pb.servicePort })),
        tlsSecretName: tlsSecretName || undefined,
        tlsHosts,
        ingressClassName: 'traefik',
        entrypoints,
        annotations: sanitizedAnnotations,
        basicAuth: data.basicAuth?.enabled ? data.basicAuth : data.basicAuth?.enabled === false ? { enabled: false, username: '', password: '' } : undefined,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to update ingress in Kubernetes: ${error.message}`);
    }

    const firstRoute = pathBackends[0];

    await this.prisma.ingress.update({
      where: { id: ingressId },
      data: {
        deploymentId: firstRoute.deploymentId,
        serviceId: firstRoute.serviceId,
        host: rawHost,
        path: firstRoute.path,
        tlsSecretName,
        tlsHosts,
        entrypoints,
        clusterIssuer,
        annotations: Object.keys(sanitizedAnnotations).length > 0 ? (sanitizedAnnotations as Prisma.JsonObject) : undefined,
      },
    });

    for (const pb of pathBackends) {
      const svc = allServices.find((s) => s.id === pb.serviceId);
      if (svc && !svc.domain) {
        await this.prisma.service.update({
          where: { id: pb.serviceId },
          data: { domain: rawHost },
        });
      }
    }

    return this.getProject(projectId, clerkId, userData);
  }

  async deleteDeploymentIngress(
    deploymentId: string,
    ingressId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    if (ingress.deploymentId !== deploymentId) {
      throw new BadRequestException('Ingress does not belong to deployment');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: ingress.deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    try {
      await this.kubernetesService.deleteIngress(ingress.namespace, ingress.name);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    await this.prisma.ingress.delete({
      where: { id: ingressId },
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async deleteProjectIngress(
    projectId: string,
    ingressId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    if (ingress.projectId !== projectId) {
      throw new BadRequestException('Ingress does not belong to project');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: ingress.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const siblings = await this.prisma.ingress.findMany({
      where: {
        namespace: ingress.namespace,
        name: ingress.name,
        id: { not: ingress.id },
      },
    });

    if (siblings.length > 0) {
      try {
        const k8sIngress = await this.kubernetesService.readIngress(
          ingress.namespace,
          ingress.name
        );
        const remainingPaths = (k8sIngress?.spec?.rules?.[0]?.http?.paths ?? [])
          .filter((p: any) => (p.path || '/') !== ingress.path)
          .map((p: any) => ({
            path: p.path || '/',
            pathType: p.pathType || 'Prefix',
            serviceName: p.backend?.service?.name || '',
            servicePort: p.backend?.service?.port?.number || 0,
          }));

        if (remainingPaths.length > 0) {
          const existingAnnotations =
            (ingress.annotations as Record<string, string> | null) ?? {};
          const existingEntrypoints = Array.isArray(ingress.entrypoints) ? ingress.entrypoints : [];

          await this.kubernetesService.updateIngress({
            namespace: ingress.namespace,
            name: ingress.name,
            host: ingress.host,
            paths: remainingPaths,
            tlsSecretName: ingress.tlsSecretName || undefined,
            tlsHosts: ingress.tlsHosts ?? [],
            ingressClassName: ingress.ingressClass || 'traefik',
            entrypoints: existingEntrypoints,
            annotations: existingAnnotations,
          });
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
      }
    } else {
      try {
        await this.kubernetesService.deleteIngress(ingress.namespace, ingress.name);
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
      }
    }

    await this.prisma.ingress.delete({
      where: { id: ingressId },
    });

    return { success: true };
  }

  async updateDeploymentIngress(
    deploymentId: string,
    ingressId: string,
    data: {
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
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ingress = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
            services: {
              include: {
                ports: true,
              },
            },
            ingresses: true,
          },
        },
      },
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    if (ingress.deploymentId !== deploymentId) {
      throw new BadRequestException('Ingress does not belong to deployment');
    }

    const deployment = ingress.deployment;

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage ingress resources');
    }

    const rawHost = String(data.host || '').trim().toLowerCase();

    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }

    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }

    const hostPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    let path = String(data.path || '/').trim();
    if (!path) {
      path = '/';
    }
    if (!path.startsWith('/')) {
      path = `/${path}`;
    }
    if (path.length > 255) {
      throw new BadRequestException('Path exceeds maximum length');
    }
    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    if (!pathPattern.test(path)) {
      throw new BadRequestException('Path contains invalid characters');
    }

    const duplicate = deployment.ingresses.find(
      (entry) => entry.id !== ingressId && entry.host === rawHost && entry.path === path
    );

    if (duplicate) {
      throw new BadRequestException('An ingress for this host and path already exists');
    }

    const ingressClassName = 'traefik';

    const tlsEnabled = data.tlsEnabled !== false;
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled && !tlsSecretName) {
      tlsSecretName = `leaf-cert-${randomUUID()}`;
      if (tlsSecretName.length > 255) {
        throw new BadRequestException('TLS secret name is too long');
      }
    } else if (!tlsEnabled) {
      tlsSecretName = null;
    }

    const clusterIssuer = tlsEnabled ? 'letsencrypt-prod' : null;

    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const annotationsInput =
      data.annotations && typeof data.annotations === 'object'
        ? data.annotations
        : {};

    const sanitizedAnnotations: Record<string, string> = {};

    for (const [key, value] of Object.entries(annotationsInput)) {
      if (value === undefined || value === null) {
        continue;
      }

      const trimmedKey = String(key || '').trim();
      if (!trimmedKey) {
        continue;
      }

      const stringValue = String(value);
      sanitizedAnnotations[trimmedKey] = stringValue;
    }

    sanitizedAnnotations['traefik.ingress.kubernetes.io/router.entrypoints'] =
      entrypoints.join(',');

    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const services = Array.isArray(deployment.services)
      ? deployment.services
      : [];

    if (services.length === 0) {
      throw new BadRequestException('Deployment has no services to attach');
    }

    const requestedServiceName = String(data.serviceName || '').trim();
    const requestedPort =
      data.servicePort !== undefined && data.servicePort !== null
        ? Number(data.servicePort)
        : null;

    if (requestedPort !== null) {
      if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
        throw new BadRequestException('Service port must be a positive integer');
      }
    }

    let targetService =
      requestedServiceName.length > 0
        ? services.find((service) => service.name === requestedServiceName)
        : null;

    if (requestedServiceName.length > 0 && !targetService) {
      throw new BadRequestException('Selected service was not found');
    }

    if (!targetService) {
      if (requestedPort !== null) {
        targetService = services.find((service) => {
          const ports = Array.isArray((service as any).ports)
            ? (service as any).ports
            : [];
          if (ports.some((port) => port.port === requestedPort)) {
            return true;
          }
          if (Number(service.port) === requestedPort) {
            return true;
          }
          return false;
        });
      }
    }

    if (!targetService) {
      targetService = ingress.serviceId
        ? services.find((s) => s.id === ingress.serviceId) || services[0]
        : services[0];
    }

    const servicePorts = Array.isArray((targetService as any).ports)
      ? (targetService as any).ports
      : [];

    let selectedPort = null as
      | {
          port: number;
          targetPort: number;
        }
      | null;

    if (requestedPort !== null) {
      selectedPort =
        servicePorts.find((port) => Number(port.port) === requestedPort) ||
        null;
      if (!selectedPort && Number(targetService.port) === requestedPort) {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null &&
            targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port),
        };
      }
    }

    if (!selectedPort) {
      if (servicePorts.length > 0) {
        const firstPort = servicePorts[0];
        selectedPort = {
          port: Number(firstPort.port),
          targetPort:
            firstPort.targetPort !== null &&
            firstPort.targetPort !== undefined
              ? Number(firstPort.targetPort)
              : Number(firstPort.port),
        };
      } else {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null &&
            targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port),
        };
      }
    }

    if (
      !Number.isInteger(selectedPort.port) ||
      selectedPort.port <= 0 ||
      !Number.isInteger(selectedPort.targetPort) ||
      selectedPort.targetPort <= 0
    ) {
      throw new BadRequestException('Resolved service port is invalid');
    }

    const tlsHosts = tlsSecretName ? [rawHost] : [];

    try {
      const basicAuthConfig = data.basicAuth?.enabled && data.basicAuth.username && data.basicAuth.password
        ? data.basicAuth
        : data.basicAuth?.enabled === false
        ? { enabled: false, username: '', password: '' }
        : undefined;

      await this.kubernetesService.updateIngress({
        namespace: ingress.namespace,
        name: ingress.name,
        host: rawHost,
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: selectedPort.port,
        serviceTargetPort: selectedPort.targetPort,
        tlsSecretName: tlsSecretName || undefined,
        tlsHosts,
        ingressClassName,
        entrypoints,
        annotations: sanitizedAnnotations,
        basicAuth: basicAuthConfig as any,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to update ingress in Kubernetes: ${error.message}`);
    }

    const annotationsPayload =
      Object.keys(sanitizedAnnotations).length > 0
        ? (sanitizedAnnotations as Prisma.JsonObject)
        : undefined;

    await this.prisma.ingress.update({
      where: { id: ingressId },
      data: {
        serviceId: targetService.id,
        host: rawHost,
        path,
        tlsSecretName,
        tlsHosts,
        entrypoints,
        clusterIssuer,
        annotations: annotationsPayload,
      },
    });

    if (!targetService.domain) {
      await this.prisma.service.update({
        where: { id: targetService.id },
        data: {
          domain: rawHost,
        },
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async deleteProject(
    projectId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.organizationId,
          userId: user.id,
        },
      },
    });

    const isProjectOwnerOrAdmin = membership && (membership.role.name === 'owner' || membership.role.name === 'admin');
    const isOrgOwnerOrAdmin = orgMembership && (orgMembership.role === 'owner' || orgMembership.role === 'admin');

    if (!isProjectOwnerOrAdmin && !isOrgOwnerOrAdmin) {
      if (!membership && !orgMembership) {
        throw new ForbiddenException('You are not a member of this project');
      }
      throw new ForbiddenException('Only project admins or organization admins can delete projects');
    }

    // Clean up Tailscale sidecars before deleting the namespace
    try {
      await this.tailscaleService.cleanupNamespace(project.namespace);
    } catch (error) {
      console.error(`[Projects] Failed to clean up Tailscale for namespace ${project.namespace}:`, error);
    }

    await this.kubernetesService.deleteNamespace(project.namespace);

    await this.prisma.project.delete({
      where: { id: projectId },
    });

    return {
      success: true,
      projectId,
      namespace: project.namespace,
    };
  }

  async getProject(
    projectId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
        members: {
          include: {
            role: true,
            user: {
              select: { id: true, email: true, username: true, firstName: true, lastName: true, imageUrl: true },
            },
          },
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        deployments: {
          include: {
            services: {
              include: {
                ports: true,
              },
            },
            ingresses: {
              include: {
                service: true,
              },
            },
            envVars: true,
            _count: {
              select: {
                pods: true,
                services: true,
              },
            },
          },
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true,
            tlsSecretName: true,
          },
        },
        databases: {
          select: {
            id: true,
            name: true,
            dbName: true,
            status: true,
            mode: true,
            createdAt: true,
          },
        },
        templateInstances: {
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            template: {
              select: {
                id: true,
                name: true,
                displayName: true,
                icon: true,
                category: true,
              },
            },
            _count: {
              select: {
                deployments: true,
                databases: true,
                ingresses: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const { orgMembership, projectMembership } = await this.assertProjectAccess(
      project.id, user.id, project.organizationId,
    );

    const isOrgAdminOrOwner = orgMembership.role === 'owner' || orgMembership.role === 'admin';
    const isProjectAdmin = projectMembership?.role.name === 'admin';
    const canEdit = isOrgAdminOrOwner || !!projectMembership;

    // Compute status for each deployment
    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const computedStatus = await this.computeDeploymentStatus(deployment);

        return {
          ...deployment,
          status: computedStatus,
        };
      })
    );

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));

    return {
      ...project,
      icon,
      deployments: deploymentsWithComputedStatus,
      currentUserRole: {
        orgRole: orgMembership.role,
        projectRole: projectMembership?.role.name ?? null,
        canEdit,
      },
    };
  }

  async updateProject(
    projectId: string,
    data: { name?: string; description?: string; repositoryUrl?: string | null; icon?: string | null; backgroundImage?: string | null },
    clerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertProjectAccess(projectId, user.id, project.organizationId);

    const updates: Prisma.ProjectUpdateInput = {};
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new BadRequestException('Project name cannot be empty');
      updates.name = name;
    }
    if (data.description !== undefined) {
      updates.description = data.description?.toString().trim() || null;
    }
    if (data.repositoryUrl !== undefined) {
      updates.repositoryUrl = data.repositoryUrl?.toString().trim() || null;
    }
    if (data.icon !== undefined) {
      const v = data.icon?.toString().trim();
      updates.icon = v ? v : null;
    }
    if (data.backgroundImage !== undefined) {
      const v = data.backgroundImage?.toString().trim();
      updates.backgroundImage = v ? v : null;
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: updates,
    });
  }

  async uploadProjectAsset(
    projectId: string,
    field: 'icon' | 'backgroundImage',
    file: Express.Multer.File,
    storageService: { uploadFile: (f: Express.Multer.File, folder: string) => Promise<string>; deleteFile: (url: string) => Promise<void> },
    clerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string },
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!existing) throw new NotFoundException('Project not found');
    await this.assertProjectAccess(projectId, user.id, existing.organizationId);

    const folder = field === 'icon' ? 'project-icons' : 'project-backgrounds';
    const url = await storageService.uploadFile(file, folder);

    const previous = existing[field];
    if (previous) {
      try { await storageService.deleteFile(previous); }
      catch (e) { console.error(`Failed to delete old ${field}:`, e); }
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { [field]: url },
    });
  }

  /**
   * Build a Prisma `where` filter for Project queries that respects RBAC:
   * - Org owner/admin → all projects in the org
   * - Org member → only projects where user is a ProjectMember
   */
  private async buildProjectAccessFilter(userId: string, orgId?: string) {
    const orgMemberships = await this.prisma.organizationMember.findMany({
      where: orgId ? { userId, organizationId: orgId } : { userId },
      select: { organizationId: true, role: true },
    });
    if (orgMemberships.length === 0) return null;

    const adminOrgIds = orgMemberships
      .filter((m) => m.role === 'owner' || m.role === 'admin')
      .map((m) => m.organizationId);
    const memberOrgIds = orgMemberships
      .filter((m) => m.role === 'member')
      .map((m) => m.organizationId);

    const conditions: any[] = [];
    if (adminOrgIds.length > 0) {
      conditions.push({ organizationId: { in: adminOrgIds } });
    }
    if (memberOrgIds.length > 0) {
      conditions.push({
        organizationId: { in: memberOrgIds },
        members: { some: { userId } },
      });
    }
    if (conditions.length === 0) return null;
    return conditions.length === 1 ? conditions[0] : { OR: conditions };
  }

  /**
   * Assert the user can access a project. Org owner/admin can access any project
   * in their org. Regular org members must be a ProjectMember.
   * Returns { orgMembership, projectMembership } for further role checks.
   */
  private async assertProjectAccess(projectId: string, userId: string, organizationId: string) {
    const [projectMembership, orgMembership] = await Promise.all([
      this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        include: { role: true },
      }),
      this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      }),
    ]);

    if (!orgMembership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const isOrgAdminOrOwner = orgMembership.role === 'owner' || orgMembership.role === 'admin';
    if (!isOrgAdminOrOwner && !projectMembership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    return { orgMembership, projectMembership };
  }

  private async assertProjectAdmin(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      include: { role: true },
    });
    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.organizationId,
          userId,
        },
      },
    });

    const isProjectAdmin = membership?.role.name === 'admin';
    const isOrgAdminOrOwner = orgMembership && (orgMembership.role === 'owner' || orgMembership.role === 'admin');

    if (!isProjectAdmin && !isOrgAdminOrOwner) {
      throw new ForbiddenException('Only project admins or organization admins can manage project members');
    }

    return project;
  }

  async addProjectMember(
    projectId: string,
    email: string,
    roleName: string,
    addedByClerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string }
  ) {
    const adder = await this.usersService.findOrCreateByClerkId(addedByClerkId, userData);
    if (!adder) throw new NotFoundException('User adding member not found');

    await this.assertProjectAdmin(projectId, adder.id);

    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) throw new BadRequestException('Email is required');

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Invalid role: ${roleName}`);

    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) throw new NotFoundException('No user with that email exists');

    const existing = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: user.id },
    });
    if (existing) throw new BadRequestException('User is already a member of this project');

    return this.prisma.projectMember.create({
      data: {
        projectId,
        userId: user.id,
        roleId: role.id,
        addedBy: adder.id,
      },
      include: {
        role: true,
        user: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true, imageUrl: true },
        },
      },
    });
  }

  async removeProjectMember(
    projectId: string,
    memberId: string,
    removedByClerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string }
  ) {
    const remover = await this.usersService.findOrCreateByClerkId(removedByClerkId, userData);
    if (!remover) throw new NotFoundException('User removing member not found');

    await this.assertProjectAdmin(projectId, remover.id);

    const member = await this.prisma.projectMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.projectId !== projectId) {
      throw new NotFoundException('Member not found in this project');
    }

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    if (adminRole && member.roleId === adminRole.id) {
      const adminCount = await this.prisma.projectMember.count({
        where: { projectId, roleId: adminRole.id },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot remove the last admin of a project');
      }
    }

    await this.prisma.projectMember.delete({ where: { id: memberId } });

    return { success: true, message: 'Member removed from project' };
  }

  async updateProjectMemberRole(
    projectId: string,
    memberId: string,
    roleName: string,
    updatedByClerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string }
  ) {
    const updater = await this.usersService.findOrCreateByClerkId(updatedByClerkId, userData);
    if (!updater) throw new NotFoundException('User updating role not found');

    await this.assertProjectAdmin(projectId, updater.id);

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Invalid role: ${roleName}`);

    const member = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
    if (!member || member.projectId !== projectId) {
      throw new NotFoundException('Member not found in this project');
    }

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    if (adminRole && member.roleId === adminRole.id && role.id !== adminRole.id) {
      const adminCount = await this.prisma.projectMember.count({
        where: { projectId, roleId: adminRole.id },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot demote the last admin of a project');
      }
    }

    return this.prisma.projectMember.update({
      where: { id: memberId },
      data: { roleId: role.id },
      include: {
        role: true,
        user: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true, imageUrl: true },
        },
      },
    });
  }

  async getProjectBySlug(organizationId: string, slug: string) {
    const project = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId,
          slug,
        },
      },
      include: {
        organization: true,
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        deployments: {
          include: {
            services: {
              include: {
                ports: true,
              },
            },
            ingresses: {
              include: {
                service: true,
              },
            },
            _count: {
              select: {
                pods: true,
                services: true,
              },
            },
          },
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project with slug ${slug} not found`);
    }

    // Compute status for each deployment
    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const computedStatus = await this.computeDeploymentStatus(deployment);

        return {
          ...deployment,
          status: computedStatus,
        };
      })
    );

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));

    return {
      ...project,
      icon,
      deployments: deploymentsWithComputedStatus,
    };
  }

  async getProjectBySlugsFull(
    orgSlug: string,
    projectSlug: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, slug: true, name: true },
    });
    if (!organization) {
      throw new NotFoundException(`Organization ${orgSlug} not found`);
    }

    const project = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: projectSlug,
        },
      },
      include: {
        organization: true,
        members: {
          include: {
            role: true,
            user: {
              select: { id: true, email: true, username: true, firstName: true, lastName: true, imageUrl: true },
            },
          },
        },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
        deployments: {
          include: {
            services: { include: { ports: true } },
            ingresses: { include: { service: true } },
            envVars: true,
            _count: { select: { pods: true, services: true } },
          },
        },
        ingresses: {
          select: { id: true, name: true, host: true, tlsSecretName: true },
        },
        databases: {
          select: { id: true, name: true, dbName: true, status: true, mode: true, createdAt: true },
        },
        templateInstances: {
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            template: {
              select: { id: true, name: true, displayName: true, icon: true, category: true },
            },
            _count: { select: { deployments: true, databases: true, ingresses: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectSlug} not found`);
    }

    const { orgMembership, projectMembership } = await this.assertProjectAccess(
      project.id, user.id, project.organizationId,
    );

    const isOrgAdminOrOwner = orgMembership.role === 'owner' || orgMembership.role === 'admin';
    const isProjectAdmin = projectMembership?.role.name === 'admin';
    const canEdit = isOrgAdminOrOwner || !!projectMembership;

    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const computedStatus = await this.computeDeploymentStatus(deployment);
        return { ...deployment, status: computedStatus };
      })
    );

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));

    return {
      ...project,
      icon,
      deployments: deploymentsWithComputedStatus,
      currentUserRole: {
        orgRole: orgMembership.role,
        projectRole: projectMembership?.role.name ?? null,
        canEdit,
      },
    };
  }

  async listProjects(userId: string, orgId?: string) {
    const where = await this.buildProjectAccessFilter(userId, orgId);
    if (!where) return [];

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        members: {
          include: {
            role: true,
            user: {
              select: { id: true, email: true, firstName: true, lastName: true, imageUrl: true },
            },
          },
        },
        deployments: {
          select: {
            id: true,
            name: true,
            status: true,
            ingresses: { select: { id: true, host: true } },
          },
        },
        _count: {
          select: { deployments: true, databases: true, ingresses: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return Promise.all(
      projects.map(async (p) => ({
        ...p,
        icon: p.icon ?? (await this.resolveProjectIconFallback(p.deployments)),
      }))
    );
  }

  /**
   * Lightweight bulk fetch of all deployments the user has access to.
   * Returns only the fields needed for the overview page — NO k8s calls.
   */
  async listDatabasesSummary(userId: string, orgId?: string) {
    const projectFilter = await this.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return [];

    return this.prisma.database.findMany({
      where: { project: projectFilter },
      select: {
        id: true,
        name: true,
        dbName: true,
        status: true,
        mode: true,
        createdAt: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async listDeploymentsSummary(userId: string, orgId?: string) {
    const projectFilter = await this.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return [];

    const deployments = await this.prisma.deployment.findMany({
      where: { project: projectFilter },
      select: {
        id: true,
        name: true,
        status: true,
        buildStatus: true,
        image: true,
        githubRepo: true,
        githubBranch: true,
        updatedAt: true,
        replicas: true,
        ingresses: {
          select: {
            id: true,
            host: true,
          },
        },
        services: {
          select: {
            ingresses: {
              select: {
                id: true,
                host: true,
              },
            },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Merge direct ingresses and service-linked ingresses, deduplicating by id
    return deployments.map(({ services, ingresses, ...rest }) => {
      const serviceIngresses = services.flatMap((s) => s.ingresses);
      const allIngresses = [...ingresses, ...serviceIngresses];
      const seen = new Set<string>();
      const uniqueIngresses = allIngresses.filter((i) => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
      return { ...rest, ingresses: uniqueIngresses };
    });
  }

  async listRecentBuilds(userId: string, orgId?: string, limit = 5) {
    const projectFilter = await this.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return { active: [], recent: [] };

    // Currently building deployments
    const activeBuilds = await this.prisma.deployment.findMany({
      where: {
        project: projectFilter,
        buildStatus: { in: ['building', 'pending'] },
      },
      select: {
        id: true,
        name: true,
        image: true,
        status: true,
        buildStatus: true,
        buildStep: true,
        updatedAt: true,
        githubRepo: true,
        githubBranch: true,
        ingresses: { select: { host: true }, take: 1 },
        project: { select: { name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    // Recent completed builds from image history
    const recentBuilds = await this.prisma.imageHistory.findMany({
      where: { deployment: { project: projectFilter } },
      select: {
        id: true,
        commitSha: true,
        branch: true,
        triggerType: true,
        isActive: true,
        createdAt: true,
        deployment: {
          select: {
            id: true,
            name: true,
            image: true,
            buildStatus: true,
            ingresses: { select: { host: true }, take: 1 },
            project: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return { active: activeBuilds, recent: recentBuilds };
  }

  async getProjectDeployments(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const deployments = await this.prisma.deployment.findMany({
      where: { projectId },
      include: {
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        pods: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    const deploymentsWithComputedStatus = await Promise.all(
      deployments.map(async (deployment) => {
        let pods: any = deployment.pods;
        let warnings: any[] = [];

        if (deployment.name && deployment.namespace) {
          try {
            const livePods = await this.kubernetesService.getDeploymentPods(
              deployment.name,
              deployment.namespace
            );
            pods = this.formatLivePods(livePods?.pods);
            warnings = livePods?.warnings || [];
          } catch (error) {
            console.error(
              `[ProjectsService] Failed to fetch live pods for deployment ${deployment.id}:`,
              error instanceof Error ? error.message : error
            );
          }
        }

        const computedStatus = await this.computeDeploymentStatus(deployment);

        return {
          ...deployment,
          pods,
          status: computedStatus,
          warnings,
        };
      })
    );

    return deploymentsWithComputedStatus;
  }

  async getDeployment(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        volumes: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        imageHistory: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            image: true,
            tag: true,
            commitSha: true,
            commitMessage: true,
            branch: true,
            isActive: true,
            createdAt: true,
            triggerType: true,
            triggeredBy: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    let pods: any = deployment.pods;
    let availableReplicas = 0;
    let warnings: any[] = [];
    let totalCpuUsage: number | null = null;
    let totalMemoryUsage: number | null = null;

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.kubernetesService.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        pods = this.formatLivePods(livePods?.pods);
        warnings = livePods?.warnings || [];
        totalCpuUsage = livePods?.totalCpuUsage ?? null;
        totalMemoryUsage = livePods?.totalMemoryUsage ?? null;

        try {
          const k8sDeployment = await this.kubernetesService.getKubernetesDeployment(
            deployment.name,
            deployment.namespace
          );
          availableReplicas = k8sDeployment?.status?.availableReplicas ?? 0;
        } catch (k8sError) {
          console.error(
            `[ProjectsService] Failed to fetch deployment status for ${deploymentId}:`,
            k8sError instanceof Error ? k8sError.message : k8sError
          );
          availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready').length ?? 0;
        }
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
        availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'running').length ?? 0;
      }
    } else {
      availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'running').length ?? 0;
    }

    const deploymentWithInternalUrls = this.addInternalUrlsToDeployment(deployment);

    // Include project-level ingresses that may be linked to a different deployment
    // but have routes targeting this deployment's services
    if (deployment.projectId && deployment.namespace) {
      const existingIngressIds: string[] = (deploymentWithInternalUrls.ingresses ?? []).map((i: any) => i.id);
      const projectIngresses = await this.prisma.ingress.findMany({
        where: {
          projectId: deployment.projectId,
          id: { notIn: existingIngressIds },
        },
        include: { service: true },
      });

      const serviceNames = new Set(
        (deployment.services ?? []).map((s: any) => s.name)
      );

      for (const pi of projectIngresses) {
        try {
          const k8sIngress = await this.kubernetesService.readIngress(deployment.namespace, pi.name);
          const rules = k8sIngress?.spec?.rules ?? [];
          const k8sPaths = rules.length > 0 && rules[0].http?.paths ? rules[0].http.paths : [];
          const hasRouteForDeployment = k8sPaths.some((p: any) =>
            serviceNames.has(p.backend?.service?.name || '')
          );
          if (hasRouteForDeployment) {
            deploymentWithInternalUrls.ingresses = [
              ...(deploymentWithInternalUrls.ingresses ?? []),
              pi,
            ];
          }
        } catch {
          // skip if K8s read fails
        }
      }
    }

    // Enrich ingresses with actual K8s routes
    if (deploymentWithInternalUrls.ingresses && deployment.namespace) {
      const enrichedIngresses = await Promise.all(
        deploymentWithInternalUrls.ingresses.map(async (ingress: any) => {
          try {
            const k8sIngress = await this.kubernetesService.readIngress(deployment.namespace, ingress.name);
            const rules = k8sIngress?.spec?.rules ?? [];
            const routes = rules.length > 0 && rules[0].http?.paths
              ? rules[0].http.paths.map((p: any) => ({
                  path: p.path || '/',
                  serviceName: p.backend?.service?.name || '',
                  servicePort: p.backend?.service?.port?.number || 0,
                }))
              : [{ path: ingress.path, serviceName: ingress.service?.name || '', servicePort: ingress.service?.port || 0 }];
            return { ...ingress, routes };
          } catch {
            return { ...ingress, routes: [{ path: ingress.path, serviceName: ingress.service?.name || '', servicePort: ingress.service?.port || 0 }] };
          }
        })
      );
      deploymentWithInternalUrls.ingresses = enrichedIngresses;
    }

    const computedStatus = await this.computeDeploymentStatus(deployment);

    // Fire-and-forget: save metrics + clean up old ones
    if (totalCpuUsage != null || totalMemoryUsage != null) {
      this.prisma.deploymentMetric.create({
        data: {
          deploymentId,
          cpuUsage: totalCpuUsage,
          memoryUsage: totalMemoryUsage != null ? BigInt(totalMemoryUsage) : null,
        },
      }).catch(err => console.error('[ProjectsService] Failed to save deployment metric:', err.message));

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      this.prisma.deploymentMetric.deleteMany({
        where: { deploymentId, createdAt: { lt: oneHourAgo } },
      }).catch(err => console.error('[ProjectsService] Failed to clean old metrics:', err.message));
    }

    // Fetch metrics history (last 1 hour)
    const metricsHistory = await this.prisma.deploymentMetric.findMany({
      where: {
        deploymentId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'asc' },
      select: { cpuUsage: true, memoryUsage: true, createdAt: true },
    }).then(rows => rows.map(r => ({
      time: r.createdAt.toISOString(),
      cpu: r.cpuUsage,
      memory: r.memoryUsage != null ? Number(r.memoryUsage) : null,
    }))).catch(err => {
      console.error('[ProjectsService] Failed to fetch metrics history:', err.message);
      return [];
    });

    return {
      ...deploymentWithInternalUrls,
      pods,
      availableReplicas,
      warnings,
      totalCpuUsage,
      totalMemoryUsage,
      metricsHistory,
      status: computedStatus,
      buildStatus: deployment.buildStatus,
    };
  }

  async getDeploymentPods(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.kubernetesService.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        return this.formatLivePods(livePods?.pods);
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    const storedPods = await this.prisma.pod.findMany({
      where: { deploymentId },
    });

    return storedPods.map((pod) => ({
      id: pod.id,
      name: pod.name,
      status: pod.status,
      ip: pod.podIp,
      podIp: pod.podIp,
      nodeName: pod.nodeName,
      restartCount: pod.restartCount,
      startTime: pod.createdAt,
      createdAt: pod.createdAt,
      containers: [],
    }));
  }

  async cancelDeploymentBuild(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (deployment.buildStatus !== 'building') {
      throw new BadRequestException('Deployment is not in a buildable state');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to cancel deployments');
    }

    try {
      console.log(`[Projects] Cancelling build jobs for deployment ${deploymentId}`);
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
      console.log(`[Projects] Successfully cancelled build jobs for deployment ${deploymentId}`);
    } catch (error) {
      console.error(`[Projects] Error cancelling build jobs for deployment ${deploymentId}:`, error);
    }

    const currentLogs = deployment.buildLogs || '';
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'failed',
        buildStep: null,
        buildError: 'Build cancelled by user',
        buildLogs: currentLogs + `[${Date.now()}] [INFO] Build cancelled by user\n`,
      },
    });

    return {
      success: true,
      deploymentId,
      message: 'Build cancelled successfully',
    };
  }

  async deleteDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to delete deployments');
    }

    // Fetch all related resources before deleting
    const [ingresses, services, volumes, imageHistoryEntries] = await Promise.all([
      this.prisma.ingress.findMany({ where: { deploymentId } }),
      this.prisma.service.findMany({ where: { deploymentId } }),
      this.prisma.deploymentVolume.findMany({ where: { deploymentId } }),
      this.prisma.imageHistory.findMany({ where: { deploymentId }, select: { image: true } }),
    ]);

    // Delete all ingresses from Kubernetes
    for (const ingress of ingresses) {
      try {
        await this.kubernetesService.deleteIngress(ingress.namespace, ingress.name);
      } catch (error) {
        console.error(`Failed to delete ingress ${ingress.name} from Kubernetes:`, error);
      }
    }

    // Delete all services from Kubernetes
    for (const service of services) {
      try {
        await this.kubernetesService.deleteService(deployment.namespace, service.name);
      } catch (error) {
        console.error(`Failed to delete service ${service.name} from Kubernetes:`, error);
      }
    }

    // Delete all PVCs from Kubernetes
    for (const volume of volumes) {
      if (volume.type === 'pvc' && volume.pvcName) {
        try {
          await this.kubernetesService.deletePVC(deployment.namespace, volume.pvcName);
        } catch (error) {
          console.error(`Failed to delete PVC ${volume.pvcName} from Kubernetes:`, error);
        }
      }
    }

    try {
      await this.kubernetesService.unexposeAllDeploymentPortsPublic(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`Failed to unexpose public ports for ${deployment.name}:`, error);
    }
    try {
      await this.kubernetesService.deletePublicDeploymentNetworkPolicy(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`Failed to delete public NetworkPolicy for ${deployment.name}:`, error);
    }

    // Clean up Tailscale sidecar if exposed
    try {
      await this.tailscaleService.cleanupDeployment(deployment);
    } catch (error) {
      console.error(`[Projects] Failed to clean up Tailscale for deployment ${deployment.name}:`, error);
    }

    // Delete the K8s deployment itself
    await this.kubernetesService.deleteDeployment(deployment.name, deployment.namespace);

    // Delete the DB record (cascades to pods, services, envVars, ingresses, volumes, imageHistory)
    await this.prisma.deployment.delete({
      where: { id: deploymentId },
    });

    // Delete all associated repositories from Harbor in the background
    if (imageHistoryEntries.length > 0) {
      const imageRefs = imageHistoryEntries.map((entry) => entry.image);
      this.dockerService.deleteRepositoriesFromRegistry(imageRefs).catch((err) => {
        console.error(`[Projects] Failed to delete repositories from registry for deployment ${deploymentId}:`, err);
      });
    }

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId,
    };
  }

  async scaleDeployment(
    deploymentId: string,
    replicas: number,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to scale deployments');
    }

    const result = await this.kubernetesService.scaleDeployment(
      deployment.name,
      deployment.namespace,
      replicas
    );

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { replicas },
    });

    return result;
  }

  async restartDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to restart deployments');
    }

    return await this.kubernetesService.restartDeployment(deployment.name, deployment.namespace);
  }

  async updateDeploymentEnvVars(
    deploymentId: string,
    env: { key: string; value: string }[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    const envEntries = Array.isArray(env)
      ? env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, string>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, entry.value);
    }

    const envList = Array.from(uniqueEnv.entries()).map(([key, value]) => ({
      key,
      value,
    }));

    await this.kubernetesService.updateDeploymentEnv({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      env: envList,
    });

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      await tx.deploymentEnvVar.deleteMany({
        where: {
          deploymentId: deployment.id,
        },
      });

      if (envList.length > 0) {
        await tx.deploymentEnvVar.createMany({
          data: envList.map((entry) => ({
            deploymentId: deployment.id,
            key: entry.key,
            value: entry.value,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          ingresses: {
            include: {
              service: true,
            },
          },
        },
      });
    });

    return updatedDeployment;
  }

  async updateDeploymentBuildFromRoot(
    deploymentId: string,
    buildFromRoot: boolean,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    buildWithDepot?: boolean,
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildFromRoot,
        ...(buildWithDepot !== undefined && { buildWithDepot }),
      },
    });

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentHealthCheck(
    deploymentId: string,
    healthCheck: {
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
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        healthCheckEnabled: healthCheck.healthCheckEnabled,
        healthCheckType: healthCheck.healthCheckType,
        healthCheckPath: healthCheck.healthCheckPath || null,
        healthCheckPort: healthCheck.healthCheckPort || null,
        healthCheckCommand: healthCheck.healthCheckCommand || null,
        livenessEnabled: healthCheck.livenessEnabled,
        readinessEnabled: healthCheck.readinessEnabled,
        startupEnabled: healthCheck.startupEnabled,
        healthCheckInterval: healthCheck.healthCheckInterval,
        healthCheckTimeout: healthCheck.healthCheckTimeout,
        healthCheckRetries: healthCheck.healthCheckRetries,
        startupFailureThreshold: healthCheck.startupFailureThreshold,
      },
    });

    // Apply to the live Kubernetes deployment
    try {
      await this.kubernetesService.updateDeploymentHealthCheck({
        namespace: deployment.namespace,
        deploymentName: deployment.name,
        enabled: healthCheck.healthCheckEnabled,
        type: healthCheck.healthCheckType,
        path: healthCheck.healthCheckPath,
        port: healthCheck.healthCheckPort,
        command: healthCheck.healthCheckCommand,
        livenessEnabled: healthCheck.livenessEnabled,
        readinessEnabled: healthCheck.readinessEnabled,
        startupEnabled: healthCheck.startupEnabled,
        interval: healthCheck.healthCheckInterval,
        timeout: healthCheck.healthCheckTimeout,
        retries: healthCheck.healthCheckRetries,
        startupFailureThreshold: healthCheck.startupFailureThreshold,
      });
    } catch (error) {
      // Log but don't fail - the DB is updated, K8s will sync on next restart/rebuild
      console.error('Failed to apply health check to Kubernetes deployment:', error.message);
    }

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentVolumes(
    deploymentId: string,
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string;
      storageSize?: string;
      hostPath?: string;
      readOnly?: boolean;
    }[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    const volumesList: Array<{
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      storageSize?: string | null;
      hostPath?: string | null;
      readOnly?: boolean;
    }> = Array.isArray(volumes)
      ? volumes
          .filter((vol) => vol && vol.name && vol.mountPath)
          .map((vol) => {
            const volType: 'pvc' | 'hostPath' | 'emptyDir' = vol.type === 'pvc' ? 'pvc' : vol.type === 'hostPath' ? 'hostPath' : 'emptyDir';
            return {
              name: vol.name.trim(),
              type: volType,
              mountPath: vol.mountPath.trim(),
              pvcName: vol.type === 'pvc' && vol.pvcName ? vol.pvcName.trim() : null,
              storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
              hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
              readOnly: Boolean(vol.readOnly),
            };
          })
          .filter((vol) => {
            if (vol.type === 'pvc' && !vol.pvcName) return false;
            if (vol.type === 'hostPath' && !vol.hostPath) return false;
            return true;
          })
      : [];

    await this.kubernetesService.updateDeploymentVolumes({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      volumes: volumesList,
    });

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      await tx.deploymentVolume.deleteMany({
        where: {
          deploymentId: deployment.id,
        },
      });

      if (volumesList.length > 0) {
        await tx.deploymentVolume.createMany({
          data: volumesList.map((vol) => ({
            deploymentId: deployment.id,
            name: vol.name,
            type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
            mountPath: vol.mountPath,
            pvcName: vol.pvcName,
            storageSize: vol.storageSize,
            hostPath: vol.hostPath,
            readOnly: vol.readOnly,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          volumes: true,
          ingresses: {
            include: {
              service: true,
            },
          },
        },
      });
    });

    return updatedDeployment;
  }

  async createDeploymentService(
    deploymentId: string,
    data: {
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
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to manage services');
    }

    const rawName = String(data.name || '').trim();
    if (!rawName) {
      throw new BadRequestException('Service name is required');
    }

    const normalizedName = this.formatSlug(rawName);
    if (!normalizedName) {
      throw new BadRequestException('Service name is invalid');
    }

    const existingServiceWithName = await this.prisma.service.findFirst({
      where: {
        name: normalizedName,
        deployment: {
          projectId: deployment.projectId,
        },
      },
    });

    if (existingServiceWithName) {
      throw new BadRequestException('A service with this name already exists in the project namespace');
    }

    const portsPayload = this.normalizeServicePortInputs(data.ports, {
      requireAtLeastOne: true,
    });

    const domainProvided = Object.prototype.hasOwnProperty.call(data ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        data.domain === null || data.domain === undefined
          ? ''
          : String(data.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    const exposePublic = data.exposePublic === true;
    const requestedType = exposePublic ? 'NodePort' : 'ClusterIP';
    const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;

    const creationResult = await this.kubernetesService.createDeploymentService({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      serviceName: normalizedName,
      type: requestedType,
      ports: portsPayload,
    });

    const resolvedPorts =
      creationResult.ports && creationResult.ports.length > 0
        ? creationResult.ports
        : portsPayload;

    const primaryPort = resolvedPorts[0];

    await this.prisma.$transaction(async (tx) => {
      const serviceRecord = await tx.service.create({
        data: {
          deploymentId: deployment.id,
          name: normalizedName,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort ?? null,
          externalIp: creationResult.externalIp ?? null,
          domain: normalizedDomain,
        },
      });

      if (resolvedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: resolvedPorts.map((port) => ({
            serviceId: serviceRecord.id,
            name: port.name,
            port: port.servicePort,
            targetPort: port.containerPort,
            protocol: port.protocol,
            nodePort: port.nodePort ?? null,
          })),
        });
      }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceConfiguration(
    deploymentId: string,
    serviceId: string,
    changes: {
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      domain?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
        ports: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: service.deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update services');
    }

    const domainProvided = Object.prototype.hasOwnProperty.call(changes ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        changes.domain === null || changes.domain === undefined
          ? ''
          : String(changes.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    let portsPayload: {
      name?: string;
      containerPort?: number;
      servicePort?: number;
      protocol?: string;
      nodePort?: number;
    }[] | null = null;

    if (Array.isArray(changes?.ports)) {
      portsPayload = this.normalizeServicePortInputs(changes.ports, {
        requireAtLeastOne: true,
      });
    }

    if (!domainProvided && portsPayload === null) {
      throw new BadRequestException('No changes provided for service update');
    }

    let updateResult:
      | {
          type: string;
          ports: {
            name: string;
            containerPort: number;
            servicePort: number;
            protocol: string;
            nodePort?: number;
          }[];
          externalIp: string | null;
        }
      | null = null;

    if (portsPayload) {
      updateResult = await this.kubernetesService.updateServicePorts({
        namespace: service.deployment.namespace,
        deploymentName: service.deployment.name,
        serviceName: service.name,
        ports: portsPayload,
      });
    }

    const resolvedPorts = updateResult
      ? updateResult.ports.map((port) => ({
          name: port.name,
          servicePort: port.servicePort,
          containerPort: port.containerPort,
          protocol: port.protocol,
          nodePort: port.nodePort ?? null,
        }))
      : service.ports.length > 0
      ? service.ports.map((port) => ({
          name: port.name || `${service.name}`,
          servicePort: port.port,
          containerPort: port.targetPort,
          protocol: port.protocol,
          nodePort: port.nodePort ?? null,
        }))
      : [
          {
            name: service.name,
            servicePort: service.port,
            containerPort: service.targetPort,
            protocol: service.protocol,
            nodePort: service.nodePort ?? null,
          },
        ];

    const primaryPort =
      resolvedPorts[0] || {
        name: service.name,
        servicePort: service.port,
        containerPort: service.targetPort,
        protocol: service.protocol,
        nodePort: service.nodePort ?? null,
      };

    const resolvedType =
      updateResult && updateResult.type === 'ClusterIP'
        ? ServiceType.internal
        : updateResult && updateResult.type !== 'ClusterIP'
        ? ServiceType.external
        : service.type;

    const resolvedExternalIp =
      updateResult && Object.prototype.hasOwnProperty.call(updateResult, 'externalIp')
        ? updateResult.externalIp
        : service.externalIp;

    const priorPublic = new Map<
      string,
      { publicEnabled: boolean; publicPort: number | null; targetPort: number; protocol: string }
    >();
    if (portsPayload) {
      for (const p of service.ports) {
        if (p.publicEnabled && p.publicPort) {
          priorPublic.set(`${p.port}:${p.protocol.toUpperCase()}`, {
            publicEnabled: true,
            publicPort: p.publicPort,
            targetPort: p.targetPort,
            protocol: p.protocol,
          });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateInput = {};

      if (portsPayload) {
        data.type = resolvedType;
        data.externalIp = resolvedExternalIp ?? null;
        data.port = primaryPort.servicePort;
        data.targetPort = primaryPort.containerPort;
        data.protocol = primaryPort.protocol;
        data.nodePort = primaryPort.nodePort ?? null;
      }

      if (domainProvided) {
        data.domain = normalizedDomain;
      }

      if (Object.keys(data).length > 0) {
        await tx.service.update({
          where: { id: service.id },
          data,
        });
      }

      if (portsPayload) {
        await tx.servicePort.deleteMany({
          where: { serviceId: service.id },
        });

        if (resolvedPorts.length > 0) {
          await tx.servicePort.createMany({
            data: resolvedPorts.map((port) => {
              const key = `${port.servicePort}:${port.protocol.toUpperCase()}`;
              const prior = priorPublic.get(key);
              return {
                serviceId: service.id,
                name: port.name,
                port: port.servicePort,
                targetPort: port.containerPort,
                protocol: port.protocol,
                nodePort: port.nodePort,
                publicEnabled: prior ? prior.publicEnabled : false,
                publicPort: prior ? prior.publicPort : null,
              };
            }),
          });
        }
      }
    });

    if (portsPayload && priorPublic.size > 0) {
      const keptKeys = new Set(
        resolvedPorts.map((p) => `${p.servicePort}:${p.protocol.toUpperCase()}`),
      );
      for (const [key, prior] of priorPublic) {
        if (keptKeys.has(key)) {
          if (prior.publicPort) {
            const kept = resolvedPorts.find(
              (p) => `${p.servicePort}:${p.protocol.toUpperCase()}` === key,
            );
            if (kept && kept.containerPort !== prior.targetPort) {
              try {
                const org = await this.prisma.organization.findUnique({
                  where: { id: service.deployment.project.organizationId },
                });
                const ip = (org?.databasePublicIp || '').trim();
                if (ip) {
                  await this.kubernetesService.exposeDeploymentPortPublic({
                    namespace: service.deployment.namespace,
                    deploymentName: service.deployment.name,
                    loadBalancerIp: ip,
                    publicPort: prior.publicPort,
                    targetPort: kept.containerPort,
                    protocol: prior.protocol,
                  });
                }
              } catch (e: any) {
                console.error(`[Deployment/public] Failed to re-expose port on update: ${e?.message}`);
              }
            }
          }
        } else if (prior.publicPort) {
          try {
            await this.kubernetesService.unexposeDeploymentPortPublic({
              namespace: service.deployment.namespace,
              deploymentName: service.deployment.name,
              publicPort: prior.publicPort,
              protocol: prior.protocol,
            });
          } catch (e: any) {
            console.error(`[Deployment/public] Failed to unexpose removed port: ${e?.message}`);
          }
        }
      }
      await this.syncPublicDeploymentNetworkPolicy(
        service.deployment.namespace,
        service.deployment.name,
        service.deployment.id,
      );
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async deleteDeploymentService(
    deploymentId: string,
    serviceId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
            services: {
              include: {
                ports: true,
              },
            },
          },
        },
        ports: true,
        ingresses: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    if (service.ingresses.length > 0) {
      throw new BadRequestException('Delete associated ingresses before removing the service');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: service.deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update services');
    }

    const otherServices = service.deployment.services.filter(
      (entry) => entry.id !== service.id
    );

    const remainingPortsInput: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    for (const entry of otherServices) {
      const servicePorts =
        entry.ports.length > 0
          ? entry.ports.map((port) => ({
              name: port.name || entry.name,
              containerPort: port.targetPort,
              servicePort: port.port,
              protocol: port.protocol,
              nodePort: port.nodePort ?? undefined,
            }))
          : [
              {
                name: entry.name,
                containerPort: entry.targetPort,
                servicePort: entry.port,
                protocol: entry.protocol,
                nodePort: entry.nodePort ?? undefined,
              },
            ];

      remainingPortsInput.push(...servicePorts);
    }

    for (const p of service.ports) {
      if (p.publicEnabled && p.publicPort) {
        try {
          await this.kubernetesService.unexposeDeploymentPortPublic({
            namespace: service.deployment.namespace,
            deploymentName: service.deployment.name,
            publicPort: p.publicPort,
            protocol: p.protocol,
          });
        } catch (e: any) {
          console.error(`[Deployment/public] Failed to unexpose port on service delete: ${e?.message}`);
        }
      }
    }

    await this.kubernetesService.deleteDeploymentService({
      namespace: service.deployment.namespace,
      deploymentName: service.deployment.name,
      serviceName: service.name,
      remainingPorts: remainingPortsInput,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.servicePort.deleteMany({
        where: { serviceId: service.id },
      });

      await tx.service.delete({
        where: { id: service.id },
      });
    });

    await this.syncPublicDeploymentNetworkPolicy(
      service.deployment.namespace,
      service.deployment.name,
      service.deployment.id,
    );

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceExposure(
    deploymentId: string,
    serviceId: string,
    exposePublic: boolean,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
        ports: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: service.deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update services');
    }

    const desiredType = exposePublic ? 'NodePort' : 'ClusterIP';

    const exposureResult = await this.kubernetesService.updateServiceExposure({
      namespace: service.deployment.namespace,
      serviceName: service.name,
      type: desiredType,
    });

    const normalizedPorts = Array.isArray(exposureResult.ports) && exposureResult.ports.length > 0
      ? exposureResult.ports.map((port) => ({
          name: port.name,
          servicePort: port.servicePort,
          containerPort: port.containerPort,
          protocol: port.protocol,
          nodePort:
            port.nodePort !== undefined && port.nodePort !== null ? port.nodePort : null,
        }))
      : service.ports.map((port) => ({
          name: port.name || `port-${port.port}`,
          servicePort: port.port,
          containerPort: port.targetPort,
          protocol: port.protocol,
          nodePort: port.nodePort ?? null,
        }));

    const primaryPort = normalizedPorts[0] || {
      name: service.name,
      servicePort: service.port,
      containerPort: service.targetPort,
      protocol: service.protocol,
      nodePort: service.nodePort ?? null,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: service.id },
        data: {
          type: exposePublic ? ServiceType.external : ServiceType.internal,
          externalIp: exposureResult.externalIp || null,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort,
        },
      });

      await tx.servicePort.deleteMany({
        where: { serviceId: service.id },
      });

      if (normalizedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: normalizedPorts.map((port) => ({
            serviceId: service.id,
            name: port.name,
            port: port.servicePort,
            targetPort: port.containerPort,
            protocol: port.protocol,
            nodePort: port.nodePort,
          })),
        });
      }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  // Auto-deploy methods

  async enableAutoDeploy(
    deploymentId: string,
    branch: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to configure auto-deploy');
    }

    // Parse the repo URL to get owner and repo
    const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
    if (!repoInfo) {
      throw new BadRequestException('Invalid GitHub repository URL');
    }

    // Check if the GitHub App has access to this repository
    const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
    if (!installation) {
      throw new BadRequestException(
        'The GitHub App is not installed on this repository. Please install the app first.'
      );
    }

    // Update the deployment with auto-deploy settings
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: true,
        autoDeployBranch: branch,
      },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    return this.addInternalUrlsToDeployment(updated);
  }

  async disableAutoDeploy(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: deployment.project.id,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to configure auto-deploy');
    }

    // Update the deployment
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: false,
      },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    return this.addInternalUrlsToDeployment(updated);
  }

  // Called by the webhook handler to trigger a deploy
  async triggerAutoDeploy(
    deploymentId: string,
    commitSha: string,
    commitMessage: string,
    commitAuthorName?: string,
    commitAuthorUsername?: string,
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    if (deployment.buildStatus === 'building') {
      console.log(`[Projects] Skipping auto-deploy for deployment ${deploymentId}: build already in progress (buildStatus: ${deployment.buildStatus})`);
      throw new BadRequestException('A build is already in progress for this deployment');
    }

    // Parse repo info for GitHub API calls
    const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);

    // Find GitHub App installation for this repo (uses app token, not user token)
    let installationId: bigint | null = null;
    let checkRunId: number | null = null;
    let installationAccessToken: string | null = null;

    if (repoInfo) {
      try {
        const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
        if (installation) {
          installationId = installation.installationId;

          // Get installation access token for cloning the repo
          installationAccessToken = await this.githubService.getOrRefreshInstallationToken(installationId);

          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const orgSlug = deployment.project?.organization?.slug;
          const logUrl = orgSlug
            ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
            : `${frontendUrl}/deployments/${deploymentId}/progress`;

          // Create a GitHub Check Run (appears under "Checks" on the commit, authored by the app)
          const checkRun = await this.githubService.createCheckRun(
            installationId,
            repoInfo.owner,
            repoInfo.repo,
            {
              name: 'Orchard Deployment',
              headSha: commitSha,
              status: 'in_progress',
              detailsUrl: logUrl,
              externalId: deploymentId,
              output: {
                title: 'Building...',
                summary: `Deploying \`${deployment.name}\` from commit \`${commitSha.substring(0, 7)}\``,
                text: `**Commit:** ${commitMessage.split('\n')[0]}\n\n**Branch:** ${deployment.autoDeployBranch || deployment.githubBranch}\n\n---\n\nBuilding...`,
              },
            }
          );

          checkRunId = checkRun.id;
          console.log(`[Projects] Created GitHub check run ${checkRunId} for deployment ${deploymentId}`);

          // Also create a GitHub Deployment (appears under "Deployments" section)
          try {
            const ghDeployment = await this.githubService.createGitHubDeploymentWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              commitSha,
              deployment.name,
              `Deploying ${deployment.name} from commit ${commitSha.substring(0, 7)}`
            );

            // Update deployment status to in_progress
            await this.githubService.updateDeploymentStatusWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              ghDeployment.id,
              'in_progress',
              { logUrl, description: 'Building...' }
            );

            // Store the GitHub deployment record
            await this.prisma.gitHubDeployment.create({
              data: {
                deploymentId,
                githubDeploymentId: BigInt(ghDeployment.id),
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                ref: deployment.autoDeployBranch || deployment.githubBranch,
                commitSha,
                environment: deployment.name,
                status: 'in_progress',
                logUrl,
              },
            });

            console.log(`[Projects] Created GitHub deployment ${ghDeployment.id} for ${deploymentId}`);
          } catch (ghErr) {
            console.error(`[Projects] Failed to create GitHub deployment: ${ghErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[Projects] Failed to create GitHub check run: ${err.message}`);
      }
    }

    // Reset build status to building
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStepTimestamps: {},
        buildLogs: `Auto-deploy triggered by push to ${deployment.autoDeployBranch || deployment.githubBranch}\nCommit: ${commitSha?.substring(0, 7)} - ${commitMessage.split('\n')[0]}\n\n`,
        buildError: null,
      },
    });

    // Extract image name from current image
    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag = imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;

    // Get service configuration
    const service = deployment.services[0];
    const rawPorts = service?.ports.map(port => ({
      name: port.name,
      containerPort: port.targetPort,
      servicePort: port.port,
      protocol: port.protocol,
      nodePort: port.nodePort || undefined,
    })) || [];

    const env = deployment.envVars.map(ev => ({
      key: ev.key,
      value: ev.value,
    }));

    const volumes = (deployment.volumes || []).map(vol => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly,
    }));

    // Start build process with GitHub check run info
    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        commitSha,
        commitMessage: commitMessage.split('\n')[0],
        commitAuthorName,
        commitAuthorUsername,
        // GitHub Check Run info (uses App, not user)
        checkRunId,
        installationId: installationId ? installationId.toString() : null,
        repoInfo,
        triggerType: 'auto',
      },
      installationAccessToken, // Use GitHub App installation token for cloning
    ).catch((error) => {
      console.error(`[Projects] Auto-deploy failed for deployment ${deploymentId}:`, error);
    });
  }

  async getAutoDeployStatus(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        autoDeployEnabled: true,
        autoDeployBranch: true,
        githubRepo: true,
        githubBranch: true,
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Check if GitHub App has access to this repo
    let appInstalled = false;
    if (deployment.githubRepo) {
      const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
      if (repoInfo) {
        try {
          const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
          appInstalled = !!installation;
        } catch {
          appInstalled = false;
        }
      }
    }

    return {
      enabled: deployment.autoDeployEnabled,
      branch: deployment.autoDeployBranch || deployment.githubBranch,
      appInstalled,
    };
  }

  async getGitHubDeployments(deploymentId: string) {
    return this.prisma.gitHubDeployment.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  // ── Database (PostgreSQL) Management ──

  private generatePassword(length = 24): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = require('crypto').randomBytes(length);
    return Array.from(bytes as Buffer, (b: number) => chars[b % chars.length]).join('');
  }

  async createDatabase(
    projectId: string,
    data: {
      name: string;
      storageSize?: string;
      templateInstanceId?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId: project.id, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this project');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to create databases');

    const nameInput = String(data.name || '').trim();
    if (!nameInput) throw new BadRequestException('Database name is required');

    const slug = this.formatSlug(nameInput);
    if (!slug) throw new BadRequestException('Invalid database name');

    // Generate unique db name from org-project-dbname
    const orgSlug = project.organization.slug.replace(/-/g, '_');
    const projSlug = project.slug.replace(/-/g, '_');
    const nameSlug = slug.replace(/-/g, '_');
    const fullDbName = `${orgSlug}_${projSlug}_${nameSlug}`;
    // PostgreSQL identifiers are limited to 63 characters; dbUser has "u_" prefix so max 61 for the base
    const maxLen = 61;
    const dbBase = fullDbName.length > maxLen ? fullDbName.substring(0, maxLen) : fullDbName;
    const dbName = dbBase;
    const dbUser = `u_${dbBase}`;
    const dbPassword = this.generatePassword();

    // Check uniqueness in our records
    const existing = await this.prisma.database.findUnique({
      where: { projectId_name: { projectId, name: nameInput } },
    });
    if (existing) throw new BadRequestException('A database with this name already exists in this project');

    const dbNameExists = await this.prisma.database.findUnique({
      where: { dbName },
    });
    if (dbNameExists) throw new BadRequestException('A database with this identifier already exists');

    // New databases get a dedicated CNPG Cluster in the project namespace.
    // K8s resource name must match DNS-1123 (lowercase, hyphens, ≤53 chars to leave room for suffixes).
    const clusterName = `pg-${this.formatSlug(nameInput).substring(0, 48)}`.replace(/^-+|-+$/g, '');
    const namespace = project.namespace;

    const org = await this.prisma.organization.findUnique({ where: { id: project.organizationId } });
    const r2 = org?.backupR2Endpoint && org?.backupR2Bucket && org?.backupR2AccessKey && org?.backupR2SecretKey
      ? {
          endpoint: org.backupR2Endpoint,
          bucket: org.backupR2Bucket,
          region: org.backupR2Region || 'auto',
          accessKey: org.backupR2AccessKey,
          secretKey: org.backupR2SecretKey,
        }
      : undefined;

    const sizeRaw = typeof data.storageSize === 'string' ? data.storageSize.trim() : '';
    const storageSize = /^\d+(Mi|Gi|Ti)$/.test(sizeRaw) ? sizeRaw : '1Gi';

    const dbResources = await this.quotasService.resolvePodResources(projectId, {
      cpuRequestMilli: data.cpuRequestMilli ?? null,
      memoryRequestBytes: data.memoryRequestBytes ?? null,
    });
    await this.quotasService.enforceOrgCapForNewPod(project.organizationId, {
      cpuMilli: dbResources.cpuMilli,
      memoryBytes: dbResources.memoryBytes,
    });
    await this.quotasService.applyProjectQuota(projectId).catch((err) => {
      console.error('[Projects] applyProjectQuota (db) failed:', err);
    });

    const { host, port } = await this.kubernetesService.createCnpgCluster({
      namespace,
      clusterName,
      dbName,
      dbUser,
      dbPassword,
      storageSize,
      r2,
      resources: dbResources,
    });

    let database;
    try {
      database = await this.prisma.database.create({
        data: {
          projectId,
          name: nameInput,
          dbName,
          dbUser,
          dbPassword,
          status: 'provisioning',
          mode: 'cnpg',
          namespace,
          clusterName,
          storageSize,
          cpuRequestMilli: data.cpuRequestMilli ?? null,
          memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
          host,
          port,
          createdBy: user.id,
          templateInstanceId: data.templateInstanceId ?? null,
        },
        include: {
          creator: {
            select: { id: true, email: true, username: true, firstName: true, lastName: true },
          },
        },
      });
    } catch (e) {
      try { await this.kubernetesService.deleteScheduledBackup(namespace, clusterName); } catch { /* ignore */ }
      try { await this.kubernetesService.unexposeCnpgCluster(namespace, clusterName); } catch { /* ignore */ }
      try { await this.kubernetesService.deleteCnpgCluster(namespace, clusterName); } catch { /* ignore */ }
      throw e;
    }

    return database;
  }

  async getDatabase(databaseId: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: { include: { organization: true } },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
    });

    if (!database) throw new NotFoundException('Database not found');

    let liveStatus: any;
    let pods: any[] = [];
    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      liveStatus = await this.kubernetesService.getCnpgClusterStatus(database.namespace, database.clusterName);
      try {
        const podList = await this.kubernetesService.listPods(database.namespace);
        pods = (podList?.pods || []).filter((p: any) =>
          p.labels?.['cnpg.io/cluster'] === database.clusterName,
        );
      } catch { /* ignore */ }

      // Reconcile stored status with live cluster state.
      if (liveStatus.ready && database.status !== 'ready' && database.status !== 'restoring') {
        try {
          await this.prisma.database.update({ where: { id: database.id }, data: { status: 'ready' } });
          database.status = 'ready';
        } catch { /* ignore */ }
      } else if (!liveStatus.exists && database.status !== 'error') {
        try {
          await this.prisma.database.update({ where: { id: database.id }, data: { status: 'error' } });
          database.status = 'error';
        } catch { /* ignore */ }
      }
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      liveStatus = await this.kubernetesService.getPostgresContainerStatus(
        database.namespace,
        database.containerName,
        database.dbName,
        database.dbUser,
      );
      try {
        const podData = await this.kubernetesService.getDeploymentPods(
          database.containerName,
          database.namespace,
        );
        pods = podData?.pods || [];
      } catch { /* ignore */ }
    } else {
      liveStatus = await this.kubernetesService.getPostgresDatabaseStatus(database.dbName);
    }

    const org = await this.prisma.organization.findUnique({ where: { id: database.project.organizationId } });
    const backupsEnabled = Boolean(
      (database.mode === 'cnpg' || database.mode === 'container') &&
      org?.backupR2Endpoint && org?.backupR2Bucket && org?.backupR2AccessKey && org?.backupR2SecretKey
    );

    let publicHostname: string | null = null;
    let publicConnectionString: string | null = null;
    if (database.publicEnabled && database.publicIp && database.publicPort && database.mode === 'cnpg' && database.clusterName && database.namespace) {
      publicHostname = this.kubernetesService.publicTlsHostname(database.clusterName);
      publicConnectionString = `postgresql://${database.dbUser}:${database.dbPassword}@${publicHostname}:${database.publicPort}/${database.dbName}?sslmode=verify-full&sslrootcert=system`;
      // Opportunistically refresh the local TLS secret copy if cert-manager rotated it.
      try {
        await this.kubernetesService.syncPublicTlsSecret(database.namespace);
      } catch { /* ignore */ }
    }

    return {
      ...database,
      connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${database.host}:${database.port}/${database.dbName}`,
      internalHost: `${database.host}:${database.port}`,
      publicHostname,
      publicConnectionString,
      liveStatus,
      backupsEnabled,
      pods,
    };
  }

  async getProjectDatabases(projectId: string) {
    return this.prisma.database.findMany({
      where: { projectId },
      include: {
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteDatabase(
    databaseId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: { include: { organization: true } } },
    });
    if (!database) throw new NotFoundException('Database not found');

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId: database.project.id, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this project');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to delete databases');

    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      try { await this.kubernetesService.deleteScheduledBackup(database.namespace, database.clusterName); } catch { /* ignore */ }
      try { await this.kubernetesService.unexposeCnpgCluster(database.namespace, database.clusterName); } catch { /* ignore */ }
      await this.kubernetesService.deleteCnpgCluster(database.namespace, database.clusterName);
    } else if (database.mode === 'container' && database.namespace && database.containerName) {
      await this.kubernetesService.deletePostgresContainer(database.namespace, database.containerName);
    } else {
      await this.kubernetesService.deletePostgresDatabase(database.dbName, database.dbUser);
    }

    await this.prisma.database.delete({ where: { id: databaseId } });

    return { success: true, message: `Database "${database.name}" deleted` };
  }

  // ── Database backup management ──

  private async assertDatabaseEditor(databaseId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: { include: { organization: true } } },
    });
    if (!database) throw new NotFoundException('Database not found');

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId: database.project.id, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this project');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to manage backups');

    return { user, database };
  }

  private async getOrgR2Config(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org?.backupR2Endpoint || !org?.backupR2Bucket || !org?.backupR2AccessKey || !org?.backupR2SecretKey) {
      throw new BadRequestException('R2 backup storage is not configured for this organization');
    }
    return org;
  }

  async listDatabaseBackups(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    const records = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id },
      orderBy: { createdAt: 'desc' },
    });

    // For CNPG, reconcile our records with live status from the Backup CRs.
    // Also, pick up any scheduled backups created directly by CNPG that we don't yet have a record for.
    if (database.mode === 'cnpg' && database.namespace && database.clusterName) {
      let anyNewlyCompleted = false;

      const runningOrPending = records.filter((r) => r.status === 'running' || r.status === 'pending');
      for (const r of runningOrPending) {
        try {
          const live = await this.kubernetesService.getCnpgBackup(database.namespace, r.backupName);
          if (!live) continue;
          const phase: string | undefined = live.status?.phase;
          if (!phase) continue;
          let newStatus: string | null = null;
          if (phase === 'completed') newStatus = 'completed';
          else if (phase === 'failed') newStatus = 'failed';
          else if (phase === 'running' || phase === 'started') newStatus = 'running';
          if (newStatus && newStatus !== r.status) {
            const completedAt = newStatus === 'completed' || newStatus === 'failed' ? new Date() : r.completedAt;
            const errorMessage = newStatus === 'failed' ? (live.status?.error || '').substring(0, 2000) : r.errorMessage;
            await this.prisma.databaseBackup.update({
              where: { id: r.id },
              data: { status: newStatus, completedAt, errorMessage },
            });
            r.status = newStatus;
            r.completedAt = completedAt || null;
            if (errorMessage !== undefined) r.errorMessage = errorMessage || null;
            if (newStatus === 'completed') anyNewlyCompleted = true;
          }
        } catch { /* ignore */ }
      }

      try {
        const liveBackups = await this.kubernetesService.listCnpgBackups(database.namespace, database.clusterName);
        const known = new Set(records.map((r) => r.backupName));
        for (const lb of liveBackups) {
          const name: string | undefined = lb.metadata?.name;
          if (!name || known.has(name)) continue;
          const phase: string | undefined = lb.status?.phase;
          const status = phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'running';
          const completedAt = (status === 'completed' || status === 'failed') ? new Date(lb.status?.stoppedAt || Date.now()) : null;
          try {
            const created = await this.prisma.databaseBackup.create({
              data: {
                databaseId: database.id,
                label: name,
                backupName: name,
                type: lb.metadata?.labels?.['cnpg.io/scheduled-backup'] ? 'scheduled' : 'full',
                status,
                completedAt,
                createdAt: new Date(lb.metadata?.creationTimestamp || Date.now()),
              },
            });
            records.unshift(created);
            if (status === 'completed') anyNewlyCompleted = true;
          } catch { /* race: another request created it */ }
        }
      } catch { /* ignore */ }

      if (anyNewlyCompleted) {
        await this.pruneOldBackups({ id: database.id, namespace: database.namespace, clusterName: database.clusterName });
      }
    }

    return records;
  }

  private readonly MAX_COMPLETED_BACKUPS = 10;

  private async pruneOldBackups(database: { id: string; namespace: string | null; clusterName: string | null }) {
    if (!database.namespace || !database.clusterName) return;
    const completed = await this.prisma.databaseBackup.findMany({
      where: { databaseId: database.id, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });
    if (completed.length <= this.MAX_COMPLETED_BACKUPS) return;
    const toDelete = completed.slice(this.MAX_COMPLETED_BACKUPS);
    for (const b of toDelete) {
      try {
        await this.kubernetesService.deleteCnpgBackup(database.namespace, b.backupName);
      } catch (e: any) {
        console.error(`[DB/backup] Failed to delete old backup CR ${b.backupName}: ${e?.message}`);
      }
      try {
        await this.prisma.databaseBackup.delete({ where: { id: b.id } });
      } catch (e: any) {
        console.error(`[DB/backup] Failed to delete old backup record ${b.id}: ${e?.message}`);
      }
    }
  }

  async createDatabaseBackup(
    databaseId: string,
    data: { label?: string; type?: 'full' | 'diff' | 'incr' },
    clerkId: string,
    userData?: any
  ) {
    const { user, database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg') {
      throw new BadRequestException('Backups are only supported for CNPG-backed databases. Recreate this database to enable backups.');
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    await this.getOrgR2Config(database.project.organizationId);

    await this.pruneOldBackups({ id: database.id, namespace: database.namespace, clusterName: database.clusterName });

    const backupName = (data.label || `backup-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`)
      .trim()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 63);

    const record = await this.prisma.databaseBackup.create({
      data: {
        databaseId: database.id,
        label: backupName,
        backupName,
        type: 'full',
        status: 'running',
        createdBy: user.id,
      },
    });

    try {
      await this.kubernetesService.createCnpgBackup(database.namespace, database.clusterName, backupName);
    } catch (e: any) {
      await this.prisma.databaseBackup.update({
        where: { id: record.id },
        data: { status: 'failed', completedAt: new Date(), errorMessage: String(e?.message || e).substring(0, 2000) },
      });
      throw new BadRequestException(`Failed to start backup: ${e?.message || e}`);
    }

    return record;
  }

  // ── Backup schedule (one cron per database) ──

  private isValidCron(expr: string): boolean {
    // CNPG accepts "quartz" 6-field cron ("seconds minutes hours day month weekday")
    // and also supports 5-field via the standard scheduler; we require 5 or 6 fields.
    const trimmed = expr.trim();
    if (!trimmed) return false;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return false;
    return parts.every((p) => /^[\d*/,\-?LW#]+$/.test(p));
  }

  private toQuartzCron(expr: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length === 5) return `0 ${parts.join(' ')}`;
    return expr.trim();
  }

  async getBackupSchedule(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    return { cron: database.backupScheduleCron || null };
  }

  async setBackupSchedule(
    databaseId: string,
    data: { cron: string },
    clerkId: string,
    userData?: any,
  ) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Scheduled backups require a CNPG-backed database');
    }
    await this.getOrgR2Config(database.project.organizationId);

    const cron = (data.cron || '').trim();
    if (!this.isValidCron(cron)) {
      throw new BadRequestException('Invalid cron expression. Expected 5 or 6 space-separated fields.');
    }

    const quartz = this.toQuartzCron(cron);
    await this.kubernetesService.upsertScheduledBackup(database.namespace, database.clusterName, quartz);
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: cron },
    });
    return { cron };
  }

  async deleteBackupSchedule(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { success: true };
    }
    try {
      await this.kubernetesService.deleteScheduledBackup(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/schedule] Failed to delete ScheduledBackup: ${e?.message}`);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { backupScheduleCron: null },
    });
    return { success: true };
  }

  async restoreDatabaseBackup(
    databaseId: string,
    backupId: string | undefined,
    clerkId: string,
    userData?: any
  ) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg') {
      throw new BadRequestException('Restore is only supported for CNPG-backed databases');
    }
    if (!database.namespace || !database.clusterName) {
      throw new BadRequestException('Database is missing cluster metadata');
    }
    if (!backupId) throw new BadRequestException('backupId is required');

    const org = await this.getOrgR2Config(database.project.organizationId);

    const backup = await this.prisma.databaseBackup.findUnique({ where: { id: backupId } });
    if (!backup || backup.databaseId !== database.id) throw new NotFoundException('Backup not found');
    if (backup.status !== 'completed') throw new BadRequestException('Backup is not completed yet');

    const oldClusterName = database.clusterName;

    await this.prisma.database.update({ where: { id: database.id }, data: { status: 'restoring' } });

    (async () => {
      try {
        const { newClusterName, host, port } = await this.kubernetesService.restoreCnpgCluster(
          database.namespace!, oldClusterName, backup.backupName,
          {
            dbName: database.dbName,
            dbUser: database.dbUser,
            dbPassword: database.dbPassword,
            storageSize: database.storageSize || '1Gi',
            parameters: (database.pgParameters as Record<string, string> | null) || undefined,
            sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || undefined,
            r2: {
              endpoint: org.backupR2Endpoint!,
              bucket: org.backupR2Bucket!,
              region: org.backupR2Region || 'auto',
              accessKey: org.backupR2AccessKey!,
              secretKey: org.backupR2SecretKey!,
            },
          },
        );

        // Wait for the new cluster to come up healthy before cutting over.
        const deadline = Date.now() + 10 * 60 * 1000;
        let healthy = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          const status = await this.kubernetesService.getCnpgClusterStatus(database.namespace!, newClusterName);
          if (status.exists && status.ready) { healthy = true; break; }
        }
        if (!healthy) {
          throw new Error('Restore cluster did not become healthy within timeout');
        }

        await this.prisma.database.update({
          where: { id: database.id },
          data: { clusterName: newClusterName, host, port, status: 'ready' },
        });

        try {
          await this.kubernetesService.deleteCnpgCluster(database.namespace!, oldClusterName);
        } catch (e: any) {
          console.error(`[DB] Failed to delete old cluster ${oldClusterName}: ${e?.message}`);
        }
      } catch (e: any) {
        console.error(`[DB] Restore failed: ${e?.message}`);
        await this.prisma.database.update({ where: { id: database.id }, data: { status: 'error' } });
      }
    })();

    return { success: true, message: 'Restore initiated — a new cluster will be provisioned from the backup and cut over when ready.' };
  }

  // ── Extensions ──

  async listDatabaseExtensions(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { extensions: [], sharedPreloadLibraries: [] };
    }
    const extensions = await this.kubernetesService.listCnpgExtensions(
      database.namespace, database.clusterName, database.dbName,
    );
    return {
      extensions,
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || [],
    };
  }

  async installDatabaseExtension(
    databaseId: string,
    data: { name: string; addToPreload?: boolean },
    clerkId: string,
    userData?: any,
  ) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Extensions require a CNPG-backed database');
    }
    if (!data.name) throw new BadRequestException('name is required');

    let preloadAdded = false;
    if (data.addToPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).slice();
      if (!existing.includes(data.name)) {
        existing.push(data.name);
        await this.kubernetesService.updateCnpgParameters(
          database.namespace, database.clusterName,
          (database.pgParameters as Record<string, string> | null) || {},
          existing,
        );
        await this.prisma.database.update({
          where: { id: database.id },
          data: { sharedPreloadLibs: existing },
        });
        preloadAdded = true;
      }
    }

    const result = await this.kubernetesService.installCnpgExtension(
      database.namespace, database.clusterName, database.dbName, data.name,
    );
    if (!result.success) {
      return { success: false, output: result.output, preloadAdded };
    }
    return { success: true, output: result.output, preloadAdded };
  }

  async uninstallDatabaseExtension(
    databaseId: string,
    data: { name: string; removeFromPreload?: boolean },
    clerkId: string,
    userData?: any,
  ) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Extensions require a CNPG-backed database');
    }
    if (!data.name) throw new BadRequestException('name is required');

    const result = await this.kubernetesService.uninstallCnpgExtension(
      database.namespace, database.clusterName, database.dbName, data.name,
    );

    if (data.removeFromPreload) {
      const existing = ((database.sharedPreloadLibs as string[] | null) || []).filter((x) => x !== data.name);
      await this.kubernetesService.updateCnpgParameters(
        database.namespace, database.clusterName,
        (database.pgParameters as Record<string, string> | null) || {},
        existing,
      );
      await this.prisma.database.update({
        where: { id: database.id },
        data: { sharedPreloadLibs: existing },
      });
    }

    return { success: result.success, output: result.output };
  }

  // ── Settings ──

  async getDatabaseSettings(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg') {
      return { parameters: {}, sharedPreloadLibraries: [] };
    }
    return {
      parameters: (database.pgParameters as Record<string, string> | null) || {},
      sharedPreloadLibraries: (database.sharedPreloadLibs as string[] | null) || [],
    };
  }

  async updateDatabaseSettings(
    databaseId: string,
    data: { parameters: Record<string, string> },
    clerkId: string,
    userData?: any,
  ) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Settings require a CNPG-backed database');
    }

    const bounds = this.PG_PARAM_BOUNDS;
    const sanitized: Record<string, string> = {};
    for (const [key, rawVal] of Object.entries(data.parameters || {})) {
      const bound = bounds[key];
      if (!bound) continue;
      const v = String(rawVal).trim();
      if (!v) continue;
      if (bound.kind === 'int') {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < bound.min || n > bound.max) {
          throw new BadRequestException(`${key} must be between ${bound.min} and ${bound.max}`);
        }
        sanitized[key] = String(n);
      } else if (bound.kind === 'memory') {
        if (!/^\d+(kB|MB|GB)$/.test(v)) {
          throw new BadRequestException(`${key} must be a memory size like "128MB"`);
        }
        sanitized[key] = v;
      } else if (bound.kind === 'string') {
        if (bound.enum && !bound.enum.includes(v)) {
          throw new BadRequestException(`${key} must be one of: ${bound.enum.join(', ')}`);
        }
        sanitized[key] = v;
      }
    }

    const existingPreload = (database.sharedPreloadLibs as string[] | null) || [];
    await this.kubernetesService.updateCnpgParameters(
      database.namespace, database.clusterName, sanitized, existingPreload,
    );
    await this.prisma.database.update({
      where: { id: database.id },
      data: { pgParameters: sanitized },
    });

    return { success: true, parameters: sanitized };
  }

  // ── Public (MetalLB) exposure ──

  private readonly PUBLIC_PORT_MIN = 30000;
  private readonly PUBLIC_PORT_MAX = 32767;

  private async pickFreePublicPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const dbPorts = new Set(dbPortsRaw.map((r) => r.publicPort).filter((n): n is number => typeof n === 'number'));

    let livePorts = new Set<number>();
    try {
      livePorts = new Set(await this.kubernetesService.listInUsePortsOnIp(ip));
    } catch (e: any) {
      console.error(`[DB/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    for (let i = 0; i < 200; i++) {
      const port = Math.floor(Math.random() * (this.PUBLIC_PORT_MAX - this.PUBLIC_PORT_MIN + 1)) + this.PUBLIC_PORT_MIN;
      if (dbPorts.has(port) || livePorts.has(port)) continue;
      return port;
    }
    throw new BadRequestException('Could not find a free public port after 200 attempts');
  }

  async enableDatabasePublic(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      throw new BadRequestException('Public exposure requires a CNPG-backed database');
    }

    const org = await this.prisma.organization.findUnique({ where: { id: database.project.organizationId } });
    const ip = (org?.databasePublicIp || '').trim();
    if (!ip) {
      throw new BadRequestException('This organization does not have a public database IP configured. Set one in organization settings.');
    }

    if (database.publicEnabled && database.publicIp === ip && database.publicPort) {
      return {
        enabled: true,
        host: database.publicIp,
        port: database.publicPort,
        connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${database.publicIp}:${database.publicPort}/${database.dbName}`,
      };
    }

    const port = database.publicIp === ip && database.publicPort
      ? database.publicPort
      : await this.pickFreePublicPort(ip);

    await this.kubernetesService.exposeCnpgClusterPublic({
      namespace: database.namespace,
      clusterName: database.clusterName,
      loadBalancerIp: ip,
      port,
    });

    // Punch a hole in the namespace's default-deny-all NetworkPolicy so external
    // clients can actually reach port 5432 on the primary pod.
    try {
      await this.kubernetesService.upsertPublicDatabaseNetworkPolicy(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to create ingress NetworkPolicy: ${e?.message}`);
    }

    // Copy the wildcard TLS secret into the project namespace and wire it into the CNPG Cluster
    // so Postgres serves the Let's Encrypt cert instead of its self-signed default.
    const hostname = this.kubernetesService.publicTlsHostname(database.clusterName);
    try {
      await this.kubernetesService.syncPublicTlsSecret(database.namespace);
      await this.kubernetesService.patchCnpgClusterTls(database.namespace, database.clusterName, [hostname]);
    } catch (e: any) {
      console.error(`[DB/public] Failed to configure TLS: ${e?.message}`);
    }

    await this.prisma.database.update({
      where: { id: database.id },
      data: { publicEnabled: true, publicIp: ip, publicPort: port },
    });

    return {
      enabled: true,
      host: hostname,
      ip,
      port,
      connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${hostname}:${port}/${database.dbName}?sslmode=verify-full&sslrootcert=system`,
    };
  }

  async disableDatabasePublic(databaseId: string, clerkId: string, userData?: any) {
    const { database } = await this.assertDatabaseEditor(databaseId, clerkId, userData);
    if (database.mode !== 'cnpg' || !database.namespace || !database.clusterName) {
      return { enabled: false };
    }
    try {
      await this.kubernetesService.unexposeCnpgCluster(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to delete public Service: ${e?.message}`);
    }
    try {
      await this.kubernetesService.clearCnpgClusterTls(database.namespace, database.clusterName);
    } catch (e: any) {
      console.error(`[DB/public] Failed to clear TLS on Cluster: ${e?.message}`);
    }
    await this.prisma.database.update({
      where: { id: database.id },
      data: { publicEnabled: false, publicIp: null, publicPort: null },
    });
    return { enabled: false };
  }

  // ── Public deployment-port exposure ──

  private async assertServicePortEditor(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any,
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const port = await this.prisma.servicePort.findUnique({
      where: { id: portId },
      include: {
        service: {
          include: {
            deployment: {
              include: { project: { include: { organization: true } } },
            },
          },
        },
      },
    });
    if (!port) throw new NotFoundException('Port not found');
    if (port.serviceId !== serviceId) throw new BadRequestException('Port does not belong to service');
    if (port.service.deploymentId !== deploymentId) throw new BadRequestException('Service does not belong to deployment');

    const deployment = port.service.deployment;
    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId: deployment.project.id, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this project');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to update services');

    return { user, port, service: port.service, deployment };
  }

  private async pickFreePublicDeploymentPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const svcPortsRaw = await this.prisma.servicePort.findMany({
      where: { publicEnabled: true, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const taken = new Set<number>();
    for (const r of dbPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);
    for (const r of svcPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);

    try {
      const live = await this.kubernetesService.listInUsePortsOnIp(ip);
      for (const p of live) taken.add(p);
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    const MIN = 30000;
    const MAX = 32767;
    for (let i = 0; i < 200; i++) {
      const port = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
      if (!taken.has(port)) return port;
    }
    throw new BadRequestException('Could not find a free public port after 200 attempts');
  }

  private async syncPublicDeploymentNetworkPolicy(namespace: string, deploymentName: string, deploymentId: string) {
    const publicPorts = await this.prisma.servicePort.findMany({
      where: {
        publicEnabled: true,
        service: { deploymentId },
      },
      select: { targetPort: true, protocol: true },
    });
    const deduped = new Map<string, { port: number; protocol: string }>();
    for (const p of publicPorts) {
      const proto = p.protocol?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
      deduped.set(`${proto}:${p.targetPort}`, { port: p.targetPort, protocol: proto });
    }
    try {
      await this.kubernetesService.upsertPublicDeploymentNetworkPolicy(
        namespace,
        deploymentName,
        Array.from(deduped.values()),
      );
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to sync NetworkPolicy: ${e?.message}`);
    }
  }

  async enableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any,
  ) {
    const { port, deployment } = await this.assertServicePortEditor(deploymentId, serviceId, portId, clerkId, userData);

    const org = await this.prisma.organization.findUnique({ where: { id: deployment.project.organizationId } });
    const ip = (org?.databasePublicIp || '').trim();
    if (!ip) {
      throw new BadRequestException('This organization does not have a public IP configured. Set one in organization settings.');
    }

    if (port.publicEnabled && port.publicPort) {
      const host = this.kubernetesService.publicDeploymentBaseDomain();
      return { enabled: true, host, ip, port: port.publicPort, protocol: port.protocol };
    }

    const publicPort = await this.pickFreePublicDeploymentPort(ip);

    await this.kubernetesService.exposeDeploymentPortPublic({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      loadBalancerIp: ip,
      publicPort,
      targetPort: port.targetPort,
      protocol: port.protocol,
    });

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: true, publicPort },
    });

    await this.syncPublicDeploymentNetworkPolicy(deployment.namespace, deployment.name, deployment.id);

    const host = this.kubernetesService.publicDeploymentBaseDomain();
    return { enabled: true, host, ip, port: publicPort, protocol: port.protocol };
  }

  async disableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any,
  ) {
    const { port, deployment } = await this.assertServicePortEditor(deploymentId, serviceId, portId, clerkId, userData);

    if (port.publicEnabled && port.publicPort) {
      try {
        await this.kubernetesService.unexposeDeploymentPortPublic({
          namespace: deployment.namespace,
          deploymentName: deployment.name,
          publicPort: port.publicPort,
          protocol: port.protocol,
        });
      } catch (e: any) {
        console.error(`[Deployment/public] Failed to delete public Service: ${e?.message}`);
      }
    }

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: false, publicPort: null },
    });

    await this.syncPublicDeploymentNetworkPolicy(deployment.namespace, deployment.name, deployment.id);

    return { enabled: false };
  }

  private readonly PG_PARAM_BOUNDS: Record<string, any> = {
    max_connections: { kind: 'int', min: 10, max: 500, requiresRestart: true },
    shared_buffers: { kind: 'memory', requiresRestart: true },
    work_mem: { kind: 'memory' },
    maintenance_work_mem: { kind: 'memory' },
    effective_cache_size: { kind: 'memory' },
    log_min_duration_statement: { kind: 'int', min: -1, max: 600000 },
    statement_timeout: { kind: 'int', min: 0, max: 3600000 },
    idle_in_transaction_session_timeout: { kind: 'int', min: 0, max: 3600000 },
    synchronous_commit: { kind: 'string', enum: ['on', 'off', 'local', 'remote_write', 'remote_apply'] },
  };
}
