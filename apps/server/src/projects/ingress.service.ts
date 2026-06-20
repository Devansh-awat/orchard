import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import * as dns from 'dns';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from './project-access.service';
import { DeploymentsService } from './deployments.service';
import { FaviconService } from './favicon.service';
import { ProjectsService } from './projects.service';
import { formatSlug } from './projects.utils';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

@Injectable()
export class IngressService {
  private readonly logger = new Logger(IngressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly usersService: UsersService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
    @Inject(forwardRef(() => DeploymentsService))
    private readonly deployments: DeploymentsService,
    @Inject(forwardRef(() => ProjectsService))
    private readonly projects: ProjectsService,
    private readonly faviconService: FaviconService,
  ) {}

  /**
   * Fire-and-forget favicon (re)fetch for a freshly created or updated
   * ingress host, so dashboard icons appear without waiting for the daily
   * refresh job. Deliberately not awaited — ingress mutations must never
   * fail or slow down because a favicon fetch is slow.
   */
  private warmFavicon(host?: string | null) {
    const domain = host?.split('/')[0]?.trim().toLowerCase();
    if (!domain) return;
    // Slight delay so the site behind a brand-new ingress has a chance to
    // start answering before we probe it.
    setTimeout(() => {
      this.faviconService.refreshFavicon(domain).catch(() => {});
    }, 10_000);
  }

  async validateIngressDns(domain: string): Promise<{ valid: boolean; message: string }> {
    const expectedCname = process.env.INGRESS_CNAME || 'ingress.lfdl.ink';
    const appDomain = process.env.APP_DOMAIN || 'a.lfdl.ink';
    const domainToCheck = domain.trim().toLowerCase();

    // Generic failure message — do NOT echo resolved DNS records back to the
    // caller. Returning resolved CNAME / A records turns this endpoint into a
    // DNS oracle for arbitrary internet domains.
    const genericFailure = {
      valid: false,
      message: 'DNS records do not point to the configured target.',
    };

    if (!domainToCheck) {
      return { valid: false, message: 'Domain is required' };
    }

    if (domainToCheck.endsWith('.' + appDomain)) {
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
      }
      return genericFailure;
    } catch (error: any) {
      // Swallow lookup errors (ENOTFOUND/ENODATA/etc) into the same generic
      // failure to avoid leaking DNS state of arbitrary domains.
      return genericFailure;
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

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

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

    const ingressClassName = 'cilium';

    const tlsEnabled = data.tlsEnabled !== false;
    const isWildcardDomain = rawHost.endsWith('.k.hackclub.dev');
    let tlsSecretName: string | null = null;
    if (tlsEnabled) {
      tlsSecretName = isWildcardDomain ? 'wildcard-k-hackclub-dev-tls' : `leaf-cert-${randomUUID()}`;
      if (tlsSecretName.length > 255) {
        throw new BadRequestException('TLS secret name is too long');
      }
    }

    const clusterIssuer = tlsEnabled && !isWildcardDomain ? 'letsencrypt-prod' : null;

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

    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
      sanitizedAnnotations['ingress.cilium.io/force-https'] = 'disabled';
    }

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
      .map((segment) => formatSlug(segment))
      .filter((segment) => segment.length > 0)
      .join('-');
    const pathSlug =
      path !== '/'
        ? formatSlug(path.replace(/\//g, '-'))
        : '';

    const nameSource = [deployment.name, hostSlug, pathSlug]
      .filter((segment) => segment.length > 0)
      .join('-');

    let baseName = formatSlug(nameSource);
    if (!baseName) {
      baseName = formatSlug(`${deployment.name}-ingress`);
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

    await this.access.assertHostnameAvailable(rawHost, deployment.projectId);

    const ingressResult = await this.k8sNetwork.createIngress({
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

    this.warmFavicon(rawHost);

    void this.audit.log({
      action: 'ingress.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'ingress',
      targetLabel: rawHost + path,
      metadata: { host: rawHost, path, tls: tlsEnabled, service: targetService.name },
    });

    return this.deployments.addInternalUrlsToDeployment(result);
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

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

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
    const isWildcardDomain = rawHost.endsWith('.k.hackclub.dev');
    const tlsSecretName = tlsEnabled ? (isWildcardDomain ? 'wildcard-k-hackclub-dev-tls' : `leaf-cert-${randomUUID()}`) : null;
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !isWildcardDomain ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (data.annotations && typeof data.annotations === 'object') {
      for (const [key, value] of Object.entries(data.annotations)) {
        if (value != null) {
          sanitizedAnnotations[String(key).trim()] = String(value);
        }
      }
    }
    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
      sanitizedAnnotations['ingress.cilium.io/force-https'] = 'disabled';
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    let baseName = formatSlug(`${deployment.name}-${hostSlug}`.substring(0, 48)) || `ingress-${Math.floor(Date.now() / 1000)}`;
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

    await this.access.assertHostnameAvailable(rawHost, deployment.projectId);

    const ingressResult = await this.k8sNetwork.createIngress({
      namespace: deployment.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends,
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: 'cilium',
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
        ingressClass: 'cilium',
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

    this.warmFavicon(rawHost);

    void this.audit.log({
      action: 'ingress.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'ingress',
      targetLabel: rawHost,
      metadata: { host: rawHost, routes: data.routes.map((r) => r.path).join(','), tls: tlsEnabled },
    });

    return this.deployments.addInternalUrlsToDeployment(result);
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

    await this.authz.requireProjectEdit(project.id, user.id, 'manage ingress resources');

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
      const k8sIngress = await this.k8sNetwork.readIngress(
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

      // Check for path collisions. A path that exists in k8s but has no
      // matching DB row is an orphan (e.g. from a previous failed create) and
      // can be safely overwritten.
      const dbPaths = new Set(existingForHost.map((e) => e.path || '/'));
      for (const pb of pathBackends) {
        const inK8s = existingPaths.some((ep) => ep.path === pb.path);
        const inDb = dbPaths.has(pb.path);
        if (inK8s && inDb) {
          throw new BadRequestException(
            `Domain ${rawHost} already routes ${pb.path} to another service. Use a different path.`
          );
        }
      }

      // Replace orphaned k8s paths, keep the rest
      const replacedPaths = new Set(pathBackends.map((pb) => pb.path));
      const mergedPaths = [
        ...existingPaths.filter((ep) => !replacedPaths.has(ep.path)),
        ...pathBackends.map((pb) => ({
        path: pb.path,
        pathType: pb.pathType,
        serviceName: pb.serviceName,
        servicePort: pb.servicePort,
      }))].sort((a, b) => b.path.length - a.path.length);

      const existingAnnotations = (mergeTarget.annotations as Record<string, string> | null) ?? {};
      const existingEntrypoints = Array.isArray(mergeTarget.entrypoints) ? mergeTarget.entrypoints : [];
      const mergedTlsEnabled = !!mergeTarget.tlsSecretName;

      await this.k8sNetwork.updateIngress({
        namespace: mergeTarget.namespace,
        name: mergeTarget.name,
        host: rawHost,
        paths: mergedPaths,
        tlsSecretName: mergeTarget.tlsSecretName || undefined,
        tlsHosts: mergeTarget.tlsHosts ?? (mergedTlsEnabled ? [rawHost] : []),
        ingressClassName: mergeTarget.ingressClass || 'cilium',
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
            ingressClass: mergeTarget.ingressClass || 'cilium',
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

      this.warmFavicon(rawHost);

      void this.audit.log({
        action: 'ingress.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: project.organizationId,
        projectId,
        targetType: 'ingress',
        targetLabel: rawHost,
        metadata: { host: rawHost, addedPaths: pathBackends.map((p) => p.path).join(','), scope: 'project_merge' },
      });

      return this.projects.getProject(projectId, clerkId, userData);
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const isWildcardDomain = rawHost.endsWith('.k.hackclub.dev');
    const tlsSecretName = tlsEnabled ? (isWildcardDomain ? 'wildcard-k-hackclub-dev-tls' : `leaf-cert-${randomUUID()}`) : null;
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !isWildcardDomain ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
      sanitizedAnnotations['ingress.cilium.io/force-https'] = 'disabled';
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    let baseName = formatSlug(`${project.slug}-${hostSlug}`.substring(0, 48)) || `ingress-${Math.floor(Date.now() / 1000)}`;
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

    await this.access.assertHostnameAvailable(rawHost, project.id);

    const ingressResult = await this.k8sNetwork.createIngress({
      namespace: project.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends.map((pb) => ({ path: pb.path, pathType: pb.pathType, serviceName: pb.serviceName, servicePort: pb.servicePort })),
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: 'cilium',
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
            ingressClass: 'cilium',
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
      try { await this.k8sNetwork.deleteIngress(project.namespace, ingressName); } catch { /* ignore */ }
      await this.prisma.ingress.deleteMany({
        where: { namespace: project.namespace, name: ingressName },
      });
      throw e;
    }

    this.warmFavicon(rawHost);

    void this.audit.log({
      action: 'ingress.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'ingress',
      targetLabel: rawHost,
      metadata: { host: rawHost, routes: pathBackends.map((p) => p.path).join(','), tls: tlsEnabled, scope: 'project' },
    });

    return this.projects.getProject(projectId, clerkId, userData);
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

    await this.access.assertProjectAccess(ingress.project.id, user.id, ingress.project.organizationId);

    // Read the actual K8s ingress to get all routes
    let k8sRoutes: Array<{ path: string; serviceName: string; servicePort: number }> = [];
    try {
      const k8sIngress = await this.k8sNetwork.readIngress(ingress.namespace, ingress.name);
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

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, projectId },
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

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    try {
      await this.access.assertProjectAccess(ingress.project.id, user.id, ingress.project.organizationId);
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException('Ingress not found');
      }
      throw e;
    }

    // Read the actual K8s ingress to get all routes
    let k8sRoutes: Array<{ path: string; serviceName: string; servicePort: number }> = [];
    try {
      const k8sIngress = await this.k8sNetwork.readIngress(ingress.namespace, ingress.name);
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
      && (ingress.annotations as any)['orchard.my/basic-auth'] === 'true';

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

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, projectId },
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

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    const project = ingress.project;

    await this.authz.requireProjectEdit(project.id, user.id, 'manage ingress resources');

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
    const isWildcardDomain = rawHost.endsWith('.k.hackclub.dev');
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled) {
      if (isWildcardDomain) {
        tlsSecretName = 'wildcard-k-hackclub-dev-tls';
      } else if (!tlsSecretName || tlsSecretName === 'wildcard-k-hackclub-dev-tls') {
        tlsSecretName = `leaf-cert-${randomUUID()}`;
      }
    } else {
      tlsSecretName = null;
    }
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !isWildcardDomain ? 'letsencrypt-prod' : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
      sanitizedAnnotations['ingress.cilium.io/force-https'] = 'disabled';
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    try {
      await this.k8sNetwork.updateIngress({
        namespace: ingress.namespace,
        name: ingress.name,
        host: rawHost,
        paths: pathBackends.map((pb) => ({ path: pb.path, pathType: pb.pathType, serviceName: pb.serviceName, servicePort: pb.servicePort })),
        tlsSecretName: tlsSecretName || undefined,
        tlsHosts,
        ingressClassName: 'cilium',
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

    this.warmFavicon(rawHost);

    void this.audit.log({
      action: 'ingress.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: rawHost,
      metadata: {
        host: [ingress.host, rawHost],
        path: [ingress.path, pathBackends[0]?.path ?? null],
        tls: [Boolean(ingress.tlsSecretName), tlsEnabled],
      },
    });

    return this.projects.getProject(projectId, clerkId, userData);
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

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, deploymentId },
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

    if (!ingress || !ingress.deployment) {
      throw new NotFoundException('Ingress not found');
    }

    await this.authz.requireProjectEdit(ingress.deployment.project.id, user.id, 'manage ingress resources');

    try {
      await this.k8sNetwork.deleteIngress(ingress.namespace, ingress.name);
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

    void this.audit.log({
      action: 'ingress.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: ingress.deployment.project.organizationId,
      projectId: ingress.deployment.projectId,
      deploymentId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: ingress.host + ingress.path,
    });

    return this.deployments.addInternalUrlsToDeployment(result);
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

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, projectId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    await this.authz.requireProjectEdit(ingress.project.id, user.id, 'manage ingress resources');

    const siblings = await this.prisma.ingress.findMany({
      where: {
        namespace: ingress.namespace,
        name: ingress.name,
        id: { not: ingress.id },
      },
    });

    if (siblings.length > 0) {
      try {
        const k8sIngress = await this.k8sNetwork.readIngress(
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

          await this.k8sNetwork.updateIngress({
            namespace: ingress.namespace,
            name: ingress.name,
            host: ingress.host,
            paths: remainingPaths,
            tlsSecretName: ingress.tlsSecretName || undefined,
            tlsHosts: ingress.tlsHosts ?? [],
            ingressClassName: ingress.ingressClass || 'cilium',
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
        await this.k8sNetwork.deleteIngress(ingress.namespace, ingress.name);
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
      }
    }

    await this.prisma.ingress.delete({
      where: { id: ingressId },
    });

    void this.audit.log({
      action: 'ingress.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: ingress.project.organizationId,
      projectId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: ingress.host + ingress.path,
      metadata: { scope: 'project' },
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

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, deploymentId },
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

    if (!ingress || !ingress.deployment) {
      throw new NotFoundException('Ingress not found');
    }

    const deployment = ingress.deployment;

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

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

    const ingressClassName = 'cilium';

    const tlsEnabled = data.tlsEnabled !== false;
    const isWildcardDomain = rawHost.endsWith('.k.hackclub.dev');
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled) {
      if (isWildcardDomain) {
        tlsSecretName = 'wildcard-k-hackclub-dev-tls';
      } else if (!tlsSecretName || tlsSecretName === 'wildcard-k-hackclub-dev-tls') {
        tlsSecretName = `leaf-cert-${randomUUID()}`;
        if (tlsSecretName.length > 255) {
          throw new BadRequestException('TLS secret name is too long');
        }
      }
    } else {
      tlsSecretName = null;
    }

    const clusterIssuer = tlsEnabled && !isWildcardDomain ? 'letsencrypt-prod' : null;

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

    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
      sanitizedAnnotations['ingress.cilium.io/force-https'] = 'disabled';
    }

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

      await this.k8sNetwork.updateIngress({
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

    this.warmFavicon(rawHost);

    void this.audit.log({
      action: 'ingress.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: rawHost,
      metadata: { host: [ingress.host, rawHost], path: [ingress.path, path] },
    });

    return this.deployments.addInternalUrlsToDeployment(result);
  }
}
