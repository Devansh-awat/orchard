import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { UsersService } from '../users/users.service';
import { DockerService } from '../docker/docker.service';
import { GitHubService } from '../github/github.service';
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
    private readonly githubService: GitHubService
  ) {}

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
    workspaceId: string,
    data: { name: string; slug?: string; description?: string; repositoryUrl?: string },
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

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        organization: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to create projects');
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
        workspaceId_slug: {
          workspaceId,
          slug,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('A project with this slug already exists in the workspace');
    }

    const namespace = this.buildNamespace([
      workspace.organization.slug,
      workspace.slug,
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

    const project = await this.prisma.project.create({
      data: {
        workspaceId,
        name,
        slug,
        description: data.description?.trim() || null,
        repositoryUrl: data.repositoryUrl?.trim() || null,
        namespace,
        createdBy: user.id,
      },
      include: {
        workspace: true,
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

    return project;
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
        hostPath?: string;
        readOnly?: boolean;
      }[];
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
        workspace: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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

    const deploymentResult = await this.kubernetesService.createDeployment({
      namespace: project.namespace,
      name,
      image,
      replicas,
      ports: rawPorts,
      env,
      serviceType: exposePublic ? 'NodePort' : 'ClusterIP',
      volumes,
    });

    const createdDeployment = await this.prisma.$transaction(async (tx) => {
      const deployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          name,
          namespace: project.namespace,
          image,
          replicas,
          status: 'pending',
          createdBy: user.id,
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
              workspace: true,
            },
          },
        },
      });
    });

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
        workspace: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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

    // Create deployment record immediately with status='building'
    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        name,
        namespace: project.namespace,
        image: `${this.dockerService.getImagePath(imageName, uniqueTag)}`, // Placeholder, will be updated
        replicas,
        status: 'building',
        buildType,
        githubRepo: repoUrl,
        githubBranch: branch,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        buildFromRoot: data.buildFromRoot ?? false,
        createdBy: user.id,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build for ${repoUrl}@${branch}\n`,
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
            workspace: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  private async buildAndDeployAsync(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
      target?: string;
      buildFromRoot?: boolean;
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
      githubDeploymentId?: number | null;
      githubAccessToken?: string | null;
      repoInfo?: { owner: string; repo: string } | null;
      // GitHub Checks API support (new - via App)
      checkRunId?: number | null;
      installationId?: string | null;
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
        buildType: data.buildType,
        imageName: data.imageName,
        tag: data.tag,
        deploymentId,
        accessToken: githubAccessToken,
      });

      const buildDuration = Math.floor((Date.now() - buildStartTime) / 1000);
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
            branch: data.branch,
            buildLogs: deployment?.buildLogs || null,
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
      const currentLogs = (await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true } }))?.buildLogs || '';
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          buildStep: 'deploying',
          buildLogs: currentLogs + '[INFO] Creating Kubernetes deployment...\n',
        },
      });

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
          await tx.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'running',
              buildStep: 'complete',
              buildLogs: (await tx.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true } }))?.buildLogs + '\n✅ Deployment created successfully!',
            },
          });
        });
      } else {
        // For rebuilds where deployment already existed, just update the status
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'running',
            buildStep: 'complete',
            buildLogs: (await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true } }))?.buildLogs + '\n✅ Rebuild completed successfully!',
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
              logUrl: `${frontendUrl}/deployments/${deploymentId}/progress`,
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
                summary: `✅ Successfully deployed \`${data.name}\`${environmentUrl ? ` to [${environmentUrl}](${environmentUrl})` : ''}`,
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
                logUrl: `${frontendUrl}/deployments/${deploymentId}/progress`,
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
          select: { buildLogs: true, buildStep: true, status: true },
        });

        // Don't overwrite a successful deployment status from a newer build
        if (currentDeployment?.status === 'running') {
          console.log(`[Projects] Deployment ${deploymentId} is already running (likely from a newer build), skipping error status update`);
          return;
        }

        const errorLogEntry = `\n❌ Build failed at step '${currentDeployment?.buildStep || 'unknown'}'\nError: ${error.message}\nError Type: ${error.constructor.name}\n`;

        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'failed',
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
              logUrl: `${frontendUrl}/deployments/${deploymentId}/progress`,
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
                logUrl: `${frontendUrl}/deployments/${deploymentId}/progress`,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to rebuild deployments');
    }

    if (deployment.status === 'building' || deployment.status === 'pending') {
      throw new BadRequestException('A build is already in progress for this deployment. Please cancel it before starting a new build.');
    }

    console.log(`[Projects] Cancelling any existing build jobs for deployment ${deploymentId}`);
    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.error(`[Projects] Error cancelling existing build jobs:`, error);
    }

    // Reset deployment to building status
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'building',
        buildStep: null,
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
            workspace: true,
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
        project: { include: { workspace: true } },
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
        project: { include: { workspace: true } },
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
        workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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

      const existing = allIngresses.find((e) => e.host === rawHost && e.path === path);
      if (existing) {
        throw new BadRequestException(`An ingress for ${rawHost}${path} already exists`);
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

    const firstRoute = pathBackends[0];

    await this.prisma.ingress.create({
      data: {
        projectId: project.id,
        deploymentId: firstRoute.deploymentId,
        serviceId: firstRoute.serviceId,
        name: ingressName,
        namespace: project.namespace,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: ingress.project.workspaceId,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: ingress.project.workspaceId,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
                workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: ingress.deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: ingress.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
                workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
      include: {
        workspace: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.workspace.organizationId,
          userId: user.id,
        },
      },
    });

    const isWorkspaceOwnerOrAdmin = membership && (membership.role.name === 'owner' || membership.role.name === 'admin');
    const isOrgOwnerOrAdmin = orgMembership && (orgMembership.role === 'owner' || orgMembership.role === 'admin');

    if (!isWorkspaceOwnerOrAdmin && !isOrgOwnerOrAdmin) {
      if (!membership && !orgMembership) {
        throw new ForbiddenException('You are not a member of this workspace or organization');
      }
      throw new ForbiddenException('Only workspace owners/admins or organization owners/admins can delete projects');
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
        workspace: {
          include: {
            organization: true,
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
          },
        },
        databases: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
    });

    const orgMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.workspace.organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership && !orgMembership) {
      throw new ForbiddenException('You are not a member of this workspace or organization');
    }

    // Compute status for each deployment
    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        let computedStatus = deployment.status;

        if (deployment.name && deployment.namespace && deployment.status === 'running') {
          try {
            const livePods = await this.kubernetesService.getDeploymentPods(
              deployment.name,
              deployment.namespace
            );
            const pods = this.formatLivePods(livePods?.pods);
            const warnings = livePods?.warnings || [];

            const hasReadyPods = pods?.some((pod: any) => pod.status?.toLowerCase() === 'ready') ?? false;

            const hasBackOffWarning = warnings.some(warning => 
              warning.message?.toLowerCase().includes('back-off') || 
              warning.message?.toLowerCase().includes('backoff') ||
              warning.message?.toLowerCase().includes('crashloop')
            );

            if (!hasReadyPods && pods?.length > 0) {
              computedStatus = 'stopped';
            } else if (hasBackOffWarning && hasReadyPods) {
              computedStatus = 'warning';
            }
          } catch (error) {
            console.error(
              `[ProjectsService] Failed to fetch live pods for deployment ${deployment.id}:`,
              error instanceof Error ? error.message : error
            );
          }
        }

        return {
          ...deployment,
          status: computedStatus,
        };
      })
    );

    return {
      ...project,
      deployments: deploymentsWithComputedStatus,
    };
  }

  async getProjectBySlug(workspaceId: string, slug: string) {
    const project = await this.prisma.project.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId,
          slug,
        },
      },
      include: {
        workspace: true,
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
      throw new NotFoundException(`Project with slug ${slug} not found in workspace`);
    }

    // Compute status for each deployment
    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        let computedStatus = deployment.status;

        if (deployment.name && deployment.namespace && deployment.status === 'running') {
          try {
            const livePods = await this.kubernetesService.getDeploymentPods(
              deployment.name,
              deployment.namespace
            );
            const pods = this.formatLivePods(livePods?.pods);
            const warnings = livePods?.warnings || [];

            const hasReadyPods = pods?.some((pod: any) => pod.status?.toLowerCase() === 'ready') ?? false;

            const hasBackOffWarning = warnings.some(warning => 
              warning.message?.toLowerCase().includes('back-off') || 
              warning.message?.toLowerCase().includes('backoff') ||
              warning.message?.toLowerCase().includes('crashloop')
            );

            if (!hasReadyPods && pods?.length > 0) {
              computedStatus = 'stopped';
            } else if (hasBackOffWarning && hasReadyPods) {
              computedStatus = 'warning';
            }
          } catch (error) {
            console.error(
              `[ProjectsService] Failed to fetch live pods for deployment ${deployment.id}:`,
              error instanceof Error ? error.message : error
            );
          }
        }

        return {
          ...deployment,
          status: computedStatus,
        };
      })
    );

    return {
      ...project,
      deployments: deploymentsWithComputedStatus,
    };
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
        let computedStatus = deployment.status;

        if (deployment.name && deployment.namespace && deployment.status === 'running') {
          try {
            const livePods = await this.kubernetesService.getDeploymentPods(
              deployment.name,
              deployment.namespace
            );
            pods = this.formatLivePods(livePods?.pods);
            warnings = livePods?.warnings || [];

            const hasReadyPods = pods?.some((pod: any) => pod.status?.toLowerCase() === 'ready') ?? false;

            const hasBackOffWarning = warnings.some(warning => 
              warning.message?.toLowerCase().includes('back-off') || 
              warning.message?.toLowerCase().includes('backoff') ||
              warning.message?.toLowerCase().includes('crashloop')
            );

            if (!hasReadyPods && pods?.length > 0) {
              computedStatus = 'stopped';
            } else if (hasBackOffWarning && hasReadyPods) {
              computedStatus = 'warning';
            }
          } catch (error) {
            console.error(
              `[ProjectsService] Failed to fetch live pods for deployment ${deployment.id}:`,
              error instanceof Error ? error.message : error
            );
          }
        }

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
            workspace: true,
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

    let computedStatus = deployment.status;
    
    if (deployment.status === 'running') {
      const hasReadyPods = pods?.some((pod: any) => pod.status?.toLowerCase() === 'ready') ?? false;

      const hasBackOffWarning = warnings.some(warning => 
        warning.message?.toLowerCase().includes('back-off') || 
        warning.message?.toLowerCase().includes('backoff') ||
        warning.message?.toLowerCase().includes('crashloop')
      );

      if (!hasReadyPods && pods?.length > 0) {
        computedStatus = 'stopped';
      } else if (hasBackOffWarning && hasReadyPods) {
        computedStatus = 'warning';
      }
    }

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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (deployment.status !== 'building' && deployment.status !== 'pending') {
      throw new BadRequestException('Deployment is not in a buildable state');
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
        status: 'failed',
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
              workspace: true,
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { buildFromRoot },
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException('You do not have permission to update deployments');
    }

    const volumesList: Array<{
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
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
              workspace: true,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
                workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: service.deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            data: resolvedPorts.map((port) => ({
              serviceId: service.id,
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
              nodePort: port.nodePort,
            })),
          });
        }
      }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            workspace: true,
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
                workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: service.deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            workspace: true,
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
                workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: service.deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
            workspace: true,
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

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
            workspace: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: deployment.project.workspaceId,
        userId: user.id,
      },
      include: {
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
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
            workspace: true,
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
  async triggerAutoDeploy(deploymentId: string, commitSha: string, commitMessage: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            workspace: true,
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

    if (deployment.status === 'building' || deployment.status === 'pending') {
      console.log(`[Projects] Skipping auto-deploy for deployment ${deploymentId}: build already in progress (status: ${deployment.status})`);
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
          const logUrl = `${frontendUrl}/deployments/${deploymentId}/progress`;

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

    // Reset deployment to building status
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'building',
        buildLogs: `🚀 Auto-deploy triggered by push to ${deployment.autoDeployBranch || deployment.githubBranch}\n📝 Commit: ${commitSha?.substring(0, 7)} - ${commitMessage.split('\n')[0]}\n\n`,
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
        // GitHub Check Run info (uses App, not user)
        checkRunId,
        installationId: installationId ? installationId.toString() : null,
        repoInfo,
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
    data: { name: string },
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
      include: { workspace: { include: { organization: true } } },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const membership = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: project.workspaceId, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this workspace');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to create databases');

    const nameInput = String(data.name || '').trim();
    if (!nameInput) throw new BadRequestException('Database name is required');

    const slug = this.formatSlug(nameInput);
    if (!slug) throw new BadRequestException('Invalid database name');

    // Generate unique db name from org-workspace-project-dbname
    const orgSlug = project.workspace.organization.slug.replace(/-/g, '_');
    const wsSlug = project.workspace.slug.replace(/-/g, '_');
    const projSlug = project.slug.replace(/-/g, '_');
    const nameSlug = slug.replace(/-/g, '_');
    const fullDbName = `${orgSlug}_${wsSlug}_${projSlug}_${nameSlug}`;
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

    // Create the actual PostgreSQL database
    await this.kubernetesService.createPostgresDatabase(dbName, dbUser, dbPassword);

    // Store in our database
    const database = await this.prisma.database.create({
      data: {
        projectId,
        name: nameInput,
        dbName,
        dbUser,
        dbPassword,
        status: 'ready',
        createdBy: user.id,
      },
      include: {
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
    });

    return database;
  }

  async getDatabase(databaseId: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        project: { include: { workspace: { include: { organization: true } } } },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true },
        },
      },
    });

    if (!database) throw new NotFoundException('Database not found');

    // Get live status from PostgreSQL
    const liveStatus = await this.kubernetesService.getPostgresDatabaseStatus(database.dbName);

    return {
      ...database,
      connectionString: `postgresql://${database.dbUser}:${database.dbPassword}@${database.host}:${database.port}/${database.dbName}`,
      internalHost: `${database.host}:${database.port}`,
      liveStatus,
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
      include: { project: { include: { workspace: true } } },
    });
    if (!database) throw new NotFoundException('Database not found');

    const membership = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: database.project.workspaceId, userId: user.id },
      include: { role: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this workspace');
    if (membership.role.name === 'viewer') throw new ForbiddenException('You do not have permission to delete databases');

    // Delete from PostgreSQL
    try {
      await this.kubernetesService.deletePostgresDatabase(database.dbName, database.dbUser);
    } catch (e) {
      console.error(`[DB] Failed to delete PostgreSQL database: ${e.message}`);
    }

    // Delete from our records
    await this.prisma.database.delete({ where: { id: databaseId } });

    return { success: true, message: `Database "${database.name}" deleted` };
  }
}
