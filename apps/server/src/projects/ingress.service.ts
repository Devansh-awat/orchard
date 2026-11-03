import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
  OnModuleInit
} from '@nestjs/common';
import * as dns from 'dns';
import { promisify } from 'util';
import { randomUUID, randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Prisma, IngressProtectionMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService, ProjectAccess } from '../auth/authorization.service';
import { normalizeBypassPath } from '../auth/protection.service';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from './project-access.service';
import { DeploymentsService } from './deployments.service';
import { FaviconService } from './favicon.service';
import { ProjectsService } from './projects.service';
import {
  formatSlug,
  scrubIngress,
  ingressTlsEnabled,
  ingressPublicUrl,
  truncateK8sName,
  platformWildcardDomains,
  desiredWildcardTls,
  OWN_CERT_PREFIX,
  CERT_CLUSTER_ISSUER
} from './projects.utils';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { INGRESS } from '../instance-config/instance-config.sections';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

const TENANT_INGRESS_CLASS = process.env.K8S_INGRESS_CLASS || 'haproxy';

// "Sign in with Orchard" bounces visitors of a tenant host to the control
// plane's login and requires project membership, so it only makes sense when
// the people being gated already have Orchard accounts. Off unless the chart
// opts in (protection.orchardLogin). Gating selection only, never enforcement:
// an operator who forgets the flag on upgrade should not have every already
// protected host fall open. Basic auth and shared-password are always offered.
const ORCHARD_LOGIN_PROTECTION_ENABLED = process.env.PROTECTION_ORCHARD_LOGIN === 'true';

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

function normalizeRedirectTarget(value: string, sourceHost: string): string {
  const raw = String(value || '').trim();
  if (!raw) throw new BadRequestException('Redirect destination is required');

  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BadRequestException('Redirect destination is invalid');
  }

  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    (target.pathname && target.pathname !== '/') ||
    target.search ||
    target.hash
  ) {
    throw new BadRequestException('Redirect destination must be an HTTP or HTTPS domain');
  }

  if (target.hostname.toLowerCase() === sourceHost) {
    throw new BadRequestException('Redirect destination must be different from the source domain');
  }

  return target.origin;
}

type BasicAuthPlan =
  | { via: 'none' }
  | { via: 'cilium' }
  | { via: 'proxy'; username: string; passwordHash: string };

function wildcardTlsSecretFor(host: string): string | null {
  return platformWildcardDomains().find((w) => host.endsWith(w.suffix))?.secret ?? null;
}

function isWildcardTlsSecret(name: string | null): boolean {
  return !!name && platformWildcardDomains().some((w) => w.secret === name);
}

import { ingressLimitReached, ingressLimits } from './ingress-limits';
import { LeaderElectionService } from '../events/leader-election.service';

export type DnsRecordHint = { type: 'CNAME' | 'A'; name: string; value: string };

@Injectable()
export class IngressService implements OnModuleInit {
  private readonly logger = new Logger(IngressService.name);

  onModuleInit(): void {
    this.instanceConfig.onWildcardChange(() => this.reconcileWildcardTls());
    this.leaderElection.onAcquired(() => {
      void this.reconcileWildcardTls();
    });
  }

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
    private readonly instanceConfig: InstanceConfigService,
    private readonly crypto: SecretCryptoService,
    private readonly leaderElection: LeaderElectionService
  ) {}

  /**
   * Bring existing ingresses in line with the current wildcard configuration.
   *
   * The wildcard secret is chosen when an ingress is created, so an instance
   * that adds a wildcard afterwards keeps issuing a certificate per app against
   * the 50-per-week limit until something repoints them, and one that removes a
   * wildcard leaves ingresses referencing a secret that no longer exists.
   *
   * Only the TLS block moves. An ingress already holding a per-host certificate
   * that is still correct is left alone, so this is safe to run on every boot.
   */
  private async assertIngressCapacity(projectId: string, deploymentId?: string): Promise<void> {
    const [project, deployment] = await Promise.all([
      this.prisma.ingress.count({ where: { projectId } }),
      deploymentId
        ? this.prisma.ingress.count({ where: { deploymentId } })
        : Promise.resolve(undefined)
    ]);
    const reason = ingressLimitReached({ project, deployment }, ingressLimits(process.env));
    if (reason) throw new BadRequestException(reason);
  }

  async reconcileWildcardTls(): Promise<{ checked: number; repointed: number }> {
    if (!this.leaderElection.isLeader()) return { checked: 0, repointed: 0 };
    const ingresses = await this.prisma.ingress.findMany({
      select: {
        id: true,
        name: true,
        namespace: true,
        host: true,
        tlsSecretName: true,
        tlsHosts: true,
        clusterIssuer: true
      }
    });

    let repointed = 0;

    for (const ingress of ingresses) {
      if (!ingress.tlsSecretName) continue;

      const decision = desiredWildcardTls(ingress.host, ingress.tlsSecretName, CERT_CLUSTER_ISSUER);
      if (!decision) continue;

      const nextSecret = decision.secretName ?? `${OWN_CERT_PREFIX}${randomUUID()}`;
      const nextIssuer = decision.clusterIssuer;
      const hosts = ingress.tlsHosts.length ? ingress.tlsHosts : [ingress.host];

      try {
        await this.k8sNetwork.patchIngressTls(
          ingress.namespace,
          ingress.name,
          { secretName: nextSecret, hosts },
          nextIssuer
        );
      } catch (e: any) {
        // A missing Ingress is not a failure worth aborting the sweep for: the
        // row outlives the object during teardown.
        if (e?.response?.statusCode !== 404) {
          this.logger.warn(
            `could not repoint TLS for ${ingress.namespace}/${ingress.name}: ${e?.message}`
          );
        }
        continue;
      }

      await this.prisma.ingress.update({
        where: { id: ingress.id },
        data: { tlsSecretName: nextSecret, clusterIssuer: nextIssuer }
      });
      repointed += 1;
    }

    if (repointed) {
      this.logger.log(`repointed ${repointed} ingress(es) after a wildcard configuration change`);
    }
    return { checked: ingresses.length, repointed };
  }

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

  async dnsRecordsFor(domain: string): Promise<DnsRecordHint[]> {
    const target = (this.instanceConfig.value(INGRESS, 'cname') || '')
      .toLowerCase()
      .replace(/\.$/, '');
    const host = domain.trim().toLowerCase().replace(/\.$/, '');
    if (!target || !host) return [];
    const labels = host.split('.');
    if (labels.length > 2) {
      return [{ type: 'CNAME', name: labels.slice(0, -2).join('.'), value: target }];
    }
    const ips = await promisify(dns.resolve4)(target).catch(() => [] as string[]);
    return ips.map((ip) => ({ type: 'A' as const, name: '@', value: ip }));
  }

  async validateIngressDns(
    domain: string
  ): Promise<{ valid: boolean; message: string; records: DnsRecordHint[] }> {
    const expectedCname = this.instanceConfig.value(INGRESS, 'cname') || '';
    const appDomain = process.env.APP_DOMAIN || '';
    const domainToCheck = domain.trim().toLowerCase();

    // Generic failure message — do NOT echo resolved DNS records back to the
    // caller. Returning resolved CNAME / A records turns this endpoint into a
    // DNS oracle for arbitrary internet domains.
    const records = await this.dnsRecordsFor(domainToCheck);
    const genericFailure = {
      valid: false,
      message: 'DNS records do not point to the configured target.',
      records
    };

    if (!domainToCheck) {
      return { valid: false, message: 'Domain is required', records };
    }

    if (appDomain && domainToCheck.endsWith(`.${appDomain}`)) {
      return { valid: true, message: 'Auto-generated domain is ready to use', records: [] };
    }

    if (!expectedCname) {
      return {
        valid: false,
        message: 'This instance has no custom-domain CNAME target configured (INGRESS_CNAME).',
        records
      };
    }

    const normalizedExpected = expectedCname.toLowerCase().replace(/\.$/, '');
    const cnames = await promisify(dns.resolveCname)(domainToCheck).catch(() => [] as string[]);
    const hasValidCname = cnames.some((record) => {
      const normalizedRecord = record.toLowerCase().replace(/\.$/, '');
      return (
        normalizedRecord === normalizedExpected ||
        normalizedRecord.endsWith(`.${normalizedExpected}`)
      );
    });
    if (hasValidCname) {
      return { valid: true, message: 'CNAME record is correctly configured', records };
    }

    const expectedIps = new Set(records.filter((r) => r.type === 'A').map((r) => r.value));
    if (expectedIps.size === 0) {
      const ips = await promisify(dns.resolve4)(normalizedExpected).catch(() => [] as string[]);
      ips.forEach((ip) => expectedIps.add(ip));
    }
    const addresses = await promisify(dns.resolve4)(domainToCheck).catch(() => [] as string[]);
    if (addresses.length > 0 && addresses.every((ip) => expectedIps.has(ip))) {
      return { valid: true, message: 'A records are correctly configured', records };
    }
    return genericFailure;
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
      routes?: { path: string; serviceName: string; servicePort: number }[];
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
            organization: true
          }
        },
        services: {
          include: {
            ports: true
          }
        },
        ingresses: true
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

    const rawHost = String(data.host || '')
      .trim()
      .toLowerCase();

    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }

    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }

    const hostPattern =
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

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

    return this.createDeploymentIngressCore(deployment, rawHost, data, {
      id: user.id,
      email: user.email
    });
  }

  /**
   * Post-authz single-route ingress creation. Callers must have loaded the
   * deployment (with project.organization, services.ports, ingresses) and
   * verified the actor can edit the project. `opts` lets platform-generated
   * ingresses mark themselves and start life behind the protection proxy.
   */
  private async createDeploymentIngressCore(
    deployment: any,
    rawHost: string,
    data: {
      path?: string;
      serviceName?: string;
      servicePort?: number;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    user: { id: string; email?: string | null },
    opts?: {
      isAutoGenerated?: boolean;
      protectionMode?: IngressProtectionMode;
    }
  ) {
    const routesInput = Array.isArray(data.routes) ? data.routes : [];

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
      requestedPort =
        data.servicePort !== undefined && data.servicePort !== null
          ? Number(data.servicePort)
          : null;
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

    const ingressClassName = TENANT_INGRESS_CLASS;

    const tlsEnabled = data.tlsEnabled !== false;
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    let tlsSecretName: string | null = null;
    if (tlsEnabled) {
      tlsSecretName = wildcardSecret ?? `${OWN_CERT_PREFIX}${randomUUID()}`;
      if (tlsSecretName.length > 255) {
        throw new BadRequestException('TLS secret name is too long');
      }
    }

    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;

    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const annotationsInput =
      data.annotations && typeof data.annotations === 'object' ? data.annotations : {};

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
    }

    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const basicAuthPlan = await this.planBasicAuth(data.basicAuth);

    const protectionMode: IngressProtectionMode = opts?.protectionMode ?? 'none';
    const protectionBypassSecret =
      protectionMode !== 'none' ? randomBytes(32).toString('hex') : null;

    if (protectionMode !== 'none') {
      sanitizedAnnotations['orchard.my/protection'] = protectionMode;
    }

    // An explicit protectionMode already puts this host behind the proxy, and
    // stacking a second challenge on top of it helps nobody.
    if (basicAuthPlan.via === 'proxy' && protectionMode !== 'none') {
      throw new BadRequestException(
        'This domain already uses Orchard protection; basic auth cannot be layered on top of it.'
      );
    }

    const services = Array.isArray(deployment.services) ? deployment.services : [];

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
          const ports = Array.isArray((service as any).ports) ? (service as any).ports : [];
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

    let selectedPort = null as {
      port: number;
      targetPort: number;
    } | null;

    if (requestedPort !== null) {
      selectedPort = servicePorts.find((port) => Number(port.port) === requestedPort) || null;
      if (!selectedPort && Number(targetService.port) === requestedPort) {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null && targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port)
        };
      }
    }

    if (!selectedPort) {
      if (servicePorts.length > 0) {
        const firstPort = servicePorts[0];
        selectedPort = {
          port: Number(firstPort.port),
          targetPort:
            firstPort.targetPort !== null && firstPort.targetPort !== undefined
              ? Number(firstPort.targetPort)
              : Number(firstPort.port)
        };
      } else {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null && targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port)
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
    const pathSlug = path !== '/' ? formatSlug(path.replace(/\//g, '-')) : '';

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

    baseName = truncateK8sName(baseName, 48) || `ingress-${Math.floor(Date.now() / 1000)}`;

    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: {
          namespace: deployment.namespace,
          name: ingressName
        }
      });

      if (!existing) {
        break;
      }

      ingressName = truncateK8sName(`${baseName}-${suffixCounter++}`);

      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    const tlsHosts = tlsSecretName ? [rawHost] : [];

    await this.assertIngressCapacity(deployment.projectId, deployment.id);
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
      basicAuth: basicAuthPlan.via === 'cilium' ? data.basicAuth : undefined
    });

    const statusRecord = Array.isArray(ingressResult.status?.loadBalancer?.ingress)
      ? ingressResult.status?.loadBalancer?.ingress?.[0] || null
      : null;

    const statusAddress = statusRecord?.ip || statusRecord?.hostname || null;

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
        protectionMode,
        protectionBypassSecret: this.crypto.seal(protectionBypassSecret),
        servicePort: selectedPort.port,
        isAutoGenerated: opts?.isAutoGenerated ?? false
      }
    });

    if (basicAuthPlan.via === 'proxy') {
      try {
        await this.enableProxyBasicAuth(deployment.namespace, ingressName, basicAuthPlan);
      } catch (error) {
        try {
          await this.k8sNetwork.deleteIngress(deployment.namespace, ingressName);
        } catch {
          /* ignore */
        }
        await this.prisma.ingress.deleteMany({
          where: { namespace: deployment.namespace, name: ingressName }
        });
        throw error;
      }
    }

    if (protectionMode !== 'none') {
      // Reconciler re-applies protection every 10 minutes, so a failure here
      // only delays the auth wall — it must not fail ingress creation.
      try {
        const result = await this.k8sNetwork.enableProtectionProxy(
          deployment.namespace,
          ingressName
        );
        if (result !== 'applied') {
          this.logger.error(
            `Protection proxy not applied to ${deployment.namespace}/${ingressName} (${result}); ` +
              'the reconciler will retry within 10 minutes'
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to enable protection proxy for ${deployment.namespace}/${ingressName}: ${error.message}`
        );
      }
    }

    if (!targetService.domain) {
      await this.prisma.service.update({
        where: { id: targetService.id },
        data: {
          domain: rawHost
        }
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        },
        project: {
          include: {
            organization: true
          }
        }
      }
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
      metadata: {
        host: rawHost,
        path,
        tls: tlsEnabled,
        service: targetService.name,
        ...(opts?.isAutoGenerated ? { auto: true, protection: protectionMode } : {})
      }
    });

    return this.deployments.addInternalUrlsToDeployment(result);
  }

  /**
   * Give a freshly created deployment a generated URL on the platform
   * wildcard domain, protected by org-member auth from birth. Returns the
   * refreshed deployment (with a convenience `url` field) or null when the
   * platform has no wildcard domain, the deployment is template/compose
   * managed, or it already has an ingress. Collisions on the generated host
   * retry with a different hash.
   */
  async createAutoIngressForDeployment(
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
    // No app domain configured means no URL can be generated at all. That used
    // to return null and get logged as a warning nobody sees, so a deployment
    // came up with no URL and no explanation. Named so callers can say why.
    const wildcard = platformWildcardDomains()[0];
    if (!wildcard) {
      this.logger.warn(
        `No app domain configured (APP_DOMAIN / PLATFORM_WILDCARD_DOMAINS), so ${deploymentId} gets no generated URL`
      );
      return null;
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) return null;

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: { include: { organization: true } },
        services: { include: { ports: true } },
        ingresses: true
      }
    });

    if (!deployment) return null;
    if (deployment.templateInstanceId || deployment.composeStackId) return null;
    if (!Array.isArray(deployment.services) || deployment.services.length === 0) return null;
    if (deployment.ingresses.length > 0) return null;

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

    const nameLabel = truncateK8sName(formatSlug(deployment.name), 40);
    const projectLabel = truncateK8sName(
      formatSlug(deployment.project.slug || deployment.project.name),
      10
    );

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const hash = createHash('sha256')
        .update(`${deployment.id}:${attempt}`)
        .digest('hex')
        .slice(0, 6);
      const label = [nameLabel, projectLabel, hash].filter(Boolean).join('-');
      const host = `${label}${wildcard.suffix}`;

      try {
        const result = await this.createDeploymentIngressCore(
          deployment,
          host,
          {},
          { id: user.id, email: user.email },
          { isAutoGenerated: true, protectionMode: 'orchard' }
        );
        if (result) {
          (result as any).url = `https://${host}`;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (error instanceof BadRequestException) continue;
        throw error;
      }
    }

    this.logger.warn(
      `Failed to create auto ingress for deployment ${deployment.id}: ${(lastError as any)?.message}`
    );
    return null;
  }

  private async createDeploymentIngressMultiRoute(
    deploymentId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      routes: { path: string; serviceName: string; servicePort: number }[];
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
        ingresses: true
      }
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
    const pathBackends: {
      path: string;
      pathType: string;
      serviceName: string;
      servicePort: number;
    }[] = [];

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

      const servicePorts = Array.isArray((targetService as any).ports)
        ? (targetService as any).ports
        : [];
      const hasPort =
        servicePorts.some((p: any) => Number(p.port) === port) ||
        Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port
      });
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    let tlsSecretName: string | null = null;
    if (tlsEnabled) {
      tlsSecretName = wildcardSecret ?? `${OWN_CERT_PREFIX}${randomUUID()}`;
    }
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;
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
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    const baseName =
      truncateK8sName(formatSlug(`${deployment.name}-${hostSlug}`), 48) ||
      `ingress-${Math.floor(Date.now() / 1000)}`;
    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: { namespace: deployment.namespace, name: ingressName }
      });
      if (!existing) break;
      ingressName = truncateK8sName(`${baseName}-${suffixCounter++}`);
      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    await this.assertIngressCapacity(deployment.projectId, deployment.id);
    await this.access.assertHostnameAvailable(rawHost, deployment.projectId);

    const basicAuthPlan = await this.planBasicAuth(data.basicAuth);

    const ingressResult = await this.k8sNetwork.createIngress({
      namespace: deployment.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends,
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: TENANT_INGRESS_CLASS,
      entrypoints,
      annotations: sanitizedAnnotations,
      basicAuth: basicAuthPlan.via === 'cilium' ? data.basicAuth : undefined
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
        ingressClass: TENANT_INGRESS_CLASS,
        entrypoints,
        clusterIssuer,
        annotations:
          Object.keys(sanitizedAnnotations).length > 0
            ? (sanitizedAnnotations as Prisma.JsonObject)
            : undefined,
        statusAddress
      }
    });

    if (basicAuthPlan.via === 'proxy') {
      try {
        await this.enableProxyBasicAuth(deployment.namespace, ingressName, basicAuthPlan);
      } catch (error) {
        try {
          await this.k8sNetwork.deleteIngress(deployment.namespace, ingressName);
        } catch {
          /* ignore */
        }
        await this.prisma.ingress.deleteMany({
          where: { namespace: deployment.namespace, name: ingressName }
        });
        throw error;
      }
    }

    if (!firstService.domain) {
      await this.prisma.service.update({
        where: { id: firstService.id },
        data: { domain: rawHost }
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        project: { include: { organization: true } },
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } }
      }
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
      metadata: { host: rawHost, routes: data.routes.map((r) => r.path).join(','), tls: tlsEnabled }
    });

    return this.deployments.addInternalUrlsToDeployment(result);
  }

  private async redirectIngressSpec(
    project: { slug: string; namespace: string },
    rawHost: string,
    tlsEnabled: boolean
  ) {
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    const tlsSecretName = tlsEnabled
      ? (wildcardSecret ?? `${OWN_CERT_PREFIX}${randomUUID()}`)
      : null;
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];
    const annotations: Record<string, string> = {};
    if (tlsEnabled) annotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
    if (clusterIssuer) annotations['cert-manager.io/cluster-issuer'] = clusterIssuer;

    const hostSlug = rawHost
      .split('.')
      .map((segment) => formatSlug(segment))
      .filter(Boolean)
      .join('-');
    const baseName =
      truncateK8sName(formatSlug(`${project.slug}-${hostSlug}-redirect`), 48) ||
      `redirect-${Math.floor(Date.now() / 1000)}`;
    let ingressName = baseName;
    let suffixCounter = 1;
    while (
      await this.prisma.ingress.findFirst({
        where: { namespace: project.namespace, name: ingressName }
      })
    ) {
      ingressName = truncateK8sName(`${baseName}-${suffixCounter++}`);
      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }
    return { ingressName, tlsSecretName, tlsHosts, clusterIssuer, entrypoints, annotations };
  }

  private async applyRedirectIngress(
    namespace: string,
    rawHost: string,
    spec: Awaited<ReturnType<IngressService['redirectIngressSpec']>>
  ): Promise<string | null> {
    const proxyServicePort = parseInt(process.env.ORCHARD_SERVER_PORT || '3001', 10);
    const ingressResult = await this.k8sNetwork.createIngress({
      namespace,
      name: spec.ingressName,
      host: rawHost,
      path: '/',
      pathType: 'Prefix',
      serviceName: 'orchard-protection-proxy',
      servicePort: proxyServicePort,
      tlsSecretName: spec.tlsSecretName || undefined,
      tlsHosts: spec.tlsHosts,
      ingressClassName: TENANT_INGRESS_CLASS,
      entrypoints: spec.entrypoints,
      annotations: spec.annotations
    });
    const statusRecord = Array.isArray(ingressResult.status?.loadBalancer?.ingress)
      ? ingressResult.status?.loadBalancer?.ingress?.[0] || null
      : null;
    const proxyResult = await this.k8sNetwork.enableProtectionProxy(namespace, spec.ingressName);
    if (proxyResult !== 'applied') {
      try {
        await this.k8sNetwork.deleteIngress(namespace, spec.ingressName);
      } catch {}
      throw new BadRequestException(
        'Could not configure the domain redirect; try again in a moment'
      );
    }
    return statusRecord?.ip || statusRecord?.hostname || null;
  }

  private async createProjectRedirectIngress(
    project: any,
    rawHost: string,
    data: {
      tlsEnabled?: boolean;
      deploymentId?: string;
      redirectTarget?: string;
      redirectStatus?: number;
    },
    user: { id: string; email?: string | null },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const redirectTarget = normalizeRedirectTarget(data.redirectTarget || '', rawHost);
    const redirectStatus = Number(data.redirectStatus ?? 307);
    if (!REDIRECT_STATUSES.has(redirectStatus)) {
      throw new BadRequestException('Redirect status must be 301, 302, 307, or 308');
    }

    const existing = project.deployments
      .flatMap((deployment) => deployment.ingresses ?? [])
      .find((ingress) => ingress.host === rawHost);
    if (existing) {
      throw new BadRequestException('This domain is already in use by the project');
    }

    const deployment = data.deploymentId
      ? project.deployments.find((entry) => entry.id === data.deploymentId)
      : project.deployments[0];
    if (!deployment) {
      throw new BadRequestException('Select an app for this redirect');
    }

    await this.assertIngressCapacity(project.id);
    await this.access.assertHostnameAvailable(rawHost, project.id);
    const spec = await this.redirectIngressSpec(project, rawHost, data.tlsEnabled !== false);
    const statusAddress = await this.applyRedirectIngress(project.namespace, rawHost, spec);

    let created;
    try {
      created = await this.prisma.ingress.create({
        data: {
          projectId: project.id,
          deploymentId: deployment.id,
          name: spec.ingressName,
          namespace: project.namespace,
          host: rawHost,
          path: '/',
          pathType: 'Prefix',
          tlsSecretName: spec.tlsSecretName,
          tlsHosts: spec.tlsHosts,
          ingressClass: TENANT_INGRESS_CLASS,
          entrypoints: spec.entrypoints,
          clusterIssuer: spec.clusterIssuer,
          annotations: Object.keys(spec.annotations).length
            ? (spec.annotations as Prisma.JsonObject)
            : undefined,
          statusAddress,
          redirectTarget,
          redirectStatus
        }
      });
    } catch (error) {
      try {
        await this.k8sNetwork.deleteIngress(project.namespace, spec.ingressName);
      } catch {}
      throw error;
    }

    void this.audit.log({
      action: 'ingress.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId: deployment.id,
      targetType: 'ingress',
      targetId: created.id,
      targetLabel: rawHost,
      metadata: { host: rawHost, redirectTarget, redirectStatus }
    });

    return this.projects.getProject(project.id, clerkId, userData);
  }

  async updateProjectRedirectIngress(
    ingress: {
      id: string;
      host: string;
      name: string;
      namespace: string;
      redirectTarget: string | null;
      redirectStatus: number | null;
      tlsSecretName: string | null;
    },
    project: any,
    data: { host?: string; redirectTarget?: string; redirectStatus?: number; tlsEnabled?: boolean },
    user: { id: string; email?: string | null }
  ) {
    const nextHost = String(data.host ?? ingress.host)
      .trim()
      .toLowerCase();
    if (!nextHost) throw new BadRequestException('Host is required');
    const target = normalizeRedirectTarget(
      data.redirectTarget ?? ingress.redirectTarget ?? '',
      nextHost
    );
    const status = Number(data.redirectStatus ?? ingress.redirectStatus ?? 307);
    if (!REDIRECT_STATUSES.has(status)) {
      throw new BadRequestException('Redirect status must be 301, 302, 307, or 308');
    }

    const hostChanged = nextHost !== ingress.host;
    let renamed: { name: string; tlsSecretName: string | null } | null = null;
    if (hostChanged) {
      const taken = project.deployments
        .flatMap((deployment) => deployment.ingresses ?? [])
        .find((entry) => entry.host === nextHost && entry.id !== ingress.id);
      if (taken) throw new BadRequestException('This domain is already in use by the project');
      await this.access.assertHostnameAvailable(nextHost, project.id);

      const tlsEnabled = data.tlsEnabled ?? Boolean(ingress.tlsSecretName);
      const spec = await this.redirectIngressSpec(project, nextHost, tlsEnabled);
      const statusAddress = await this.applyRedirectIngress(project.namespace, nextHost, spec);
      await this.prisma.ingress.update({
        where: { id: ingress.id },
        data: {
          host: nextHost,
          name: spec.ingressName,
          tlsSecretName: spec.tlsSecretName,
          tlsHosts: spec.tlsHosts,
          entrypoints: spec.entrypoints,
          clusterIssuer: spec.clusterIssuer,
          annotations: Object.keys(spec.annotations).length
            ? (spec.annotations as Prisma.JsonObject)
            : undefined,
          statusAddress,
          redirectTarget: target,
          redirectStatus: status
        }
      });
      renamed = { name: spec.ingressName, tlsSecretName: spec.tlsSecretName };
      try {
        await this.k8sNetwork.deleteIngress(project.namespace, ingress.name);
      } catch (error) {
        this.logger.warn(
          `old redirect ingress ${project.namespace}/${ingress.name} was not removed after renaming to ${nextHost}: ${error?.message}`
        );
      }
    } else {
      await this.prisma.ingress.update({
        where: { id: ingress.id },
        data: { redirectTarget: target, redirectStatus: status }
      });
    }

    void this.audit.log({
      action: 'ingress.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      targetType: 'ingress',
      targetId: ingress.id,
      targetLabel: nextHost,
      metadata: {
        host: [ingress.host, nextHost],
        redirectTarget: [ingress.redirectTarget, target],
        redirectStatus: [ingress.redirectStatus, status],
        ingressName: renamed ? [ingress.name, renamed.name] : undefined
      }
    });
  }

  async createProjectIngress(
    projectId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      deploymentId?: string;
      redirectTarget?: string;
      redirectStatus?: number;
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
            ingresses: true
          }
        }
      }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'manage ingress resources');

    const rawHost = String(data.host || '')
      .trim()
      .toLowerCase();
    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }
    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }
    const hostPattern =
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    if (data.redirectTarget) {
      return this.createProjectRedirectIngress(project, rawHost, data, user, clerkId, userData);
    }

    const routes = Array.isArray(data.routes) && data.routes.length > 0 ? data.routes : null;
    if (!routes || routes.length === 0) {
      throw new BadRequestException('At least one route is required');
    }

    const allServices = project.deployments.flatMap((d) =>
      (d.services ?? []).map((s) => ({ ...s, deploymentId: d.id }))
    );
    const allIngresses = project.deployments.flatMap((d) => d.ingresses ?? []);

    if (allServices.length === 0) {
      throw new BadRequestException('Project has no services');
    }

    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    const pathBackends: {
      path: string;
      pathType: string;
      serviceName: string;
      servicePort: number;
      serviceId: string;
      deploymentId: string;
    }[] = [];

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

      const targetService = allServices.find(
        (s) => s.name === String(route.serviceName || '').trim()
      );
      if (!targetService) {
        throw new BadRequestException(`Service ${route.serviceName} not found in project`);
      }

      const port = Number(route.servicePort);
      if (!Number.isInteger(port) || port <= 0) {
        throw new BadRequestException(`Invalid service port for ${route.serviceName}`);
      }

      const servicePorts = Array.isArray((targetService as any).ports)
        ? (targetService as any).ports
        : [];
      const hasPort =
        servicePorts.some((p: any) => Number(p.port) === port) ||
        Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port,
        serviceId: targetService.id,
        deploymentId: (targetService as any).deploymentId
      });
    }

    const existingForHost = allIngresses.filter((e) => e.host === rawHost);
    const mergeTarget = existingForHost[0] ?? null;

    if (mergeTarget) {
      const k8sIngress = await this.k8sNetwork.readIngress(mergeTarget.namespace, mergeTarget.name);
      const existingPaths: {
        path: string;
        pathType: string;
        serviceName: string;
        servicePort: number;
      }[] = (k8sIngress?.spec?.rules?.[0]?.http?.paths ?? []).map((p: any) => ({
        path: p.path || '/',
        pathType: p.pathType || 'Prefix',
        serviceName: p.backend?.service?.name || '',
        servicePort: p.backend?.service?.port?.number || 0
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
          servicePort: pb.servicePort
        }))
      ].sort((a, b) => b.path.length - a.path.length);

      const existingAnnotations = (mergeTarget.annotations as Record<string, string> | null) ?? {};
      const existingEntrypoints = Array.isArray(mergeTarget.entrypoints)
        ? mergeTarget.entrypoints
        : [];
      const mergedTlsEnabled = !!mergeTarget.tlsSecretName;

      await this.k8sNetwork.updateIngress({
        namespace: mergeTarget.namespace,
        name: mergeTarget.name,
        host: rawHost,
        paths: mergedPaths,
        tlsSecretName: mergeTarget.tlsSecretName || undefined,
        tlsHosts: mergeTarget.tlsHosts ?? (mergedTlsEnabled ? [rawHost] : []),
        ingressClassName: TENANT_INGRESS_CLASS,
        entrypoints: existingEntrypoints,
        annotations: existingAnnotations
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
            ingressClass: TENANT_INGRESS_CLASS,
            entrypoints: existingEntrypoints,
            clusterIssuer: mergeTarget.clusterIssuer,
            annotations:
              Object.keys(existingAnnotations).length > 0
                ? (existingAnnotations as Prisma.JsonObject)
                : undefined,
            statusAddress: mergeTarget.statusAddress,
            servicePort: pb.servicePort,
            templateInstanceId: data.templateInstanceId ?? null
          }
        });

        const svc = allServices.find((s) => s.id === pb.serviceId);
        if (svc && !svc.domain) {
          await this.prisma.service.update({
            where: { id: pb.serviceId },
            data: { domain: rawHost }
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
        metadata: {
          host: rawHost,
          addedPaths: pathBackends.map((p) => p.path).join(','),
          scope: 'project_merge'
        }
      });

      return this.projects.getProject(projectId, clerkId, userData);
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    let tlsSecretName: string | null = null;
    if (tlsEnabled) {
      tlsSecretName = wildcardSecret ?? `${OWN_CERT_PREFIX}${randomUUID()}`;
    }
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const hostSlug = rawHost
      .split('.')
      .map((s) => formatSlug(s))
      .filter((s) => s.length > 0)
      .join('-');
    const baseName =
      truncateK8sName(formatSlug(`${project.slug}-${hostSlug}`), 48) ||
      `ingress-${Math.floor(Date.now() / 1000)}`;
    let ingressName = baseName;
    let suffixCounter = 1;

    while (true) {
      const existing = await this.prisma.ingress.findFirst({
        where: { namespace: project.namespace, name: ingressName }
      });
      if (!existing) break;
      ingressName = truncateK8sName(`${baseName}-${suffixCounter++}`);
      if (suffixCounter > 50) {
        throw new BadRequestException('Failed to generate unique ingress name');
      }
    }

    await this.assertIngressCapacity(project.id);
    await this.access.assertHostnameAvailable(rawHost, project.id);

    const basicAuthPlan = await this.planBasicAuth(data.basicAuth);

    const ingressResult = await this.k8sNetwork.createIngress({
      namespace: project.namespace,
      name: ingressName,
      host: rawHost,
      paths: pathBackends.map((pb) => ({
        path: pb.path,
        pathType: pb.pathType,
        serviceName: pb.serviceName,
        servicePort: pb.servicePort
      })),
      tlsSecretName: tlsSecretName || undefined,
      tlsHosts,
      ingressClassName: TENANT_INGRESS_CLASS,
      entrypoints,
      annotations: sanitizedAnnotations,
      basicAuth: basicAuthPlan.via === 'cilium' ? data.basicAuth : undefined
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
            ingressClass: TENANT_INGRESS_CLASS,
            entrypoints,
            clusterIssuer,
            annotations:
              Object.keys(sanitizedAnnotations).length > 0
                ? (sanitizedAnnotations as Prisma.JsonObject)
                : undefined,
            statusAddress,
            servicePort: pb.servicePort,
            templateInstanceId: data.templateInstanceId ?? null
          }
        });

        const svc = allServices.find((s) => s.id === pb.serviceId);
        if (svc && !svc.domain) {
          await this.prisma.service.update({
            where: { id: pb.serviceId },
            data: { domain: rawHost }
          });
        }
      }

      if (basicAuthPlan.via === 'proxy') {
        await this.enableProxyBasicAuth(project.namespace, ingressName, basicAuthPlan);
      }
    } catch (e) {
      try {
        await this.k8sNetwork.deleteIngress(project.namespace, ingressName);
      } catch {
        /* ignore */
      }
      await this.prisma.ingress.deleteMany({
        where: { namespace: project.namespace, name: ingressName }
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
      metadata: {
        host: rawHost,
        routes: pathBackends.map((p) => p.path).join(','),
        tls: tlsEnabled,
        scope: 'project'
      }
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
              select: {
                id: true,
                name: true,
                displayName: true,
                status: true,
                services: { include: { ports: true } }
              }
            }
          }
        },
        deployment: { select: { id: true, name: true, displayName: true, status: true } },
        service: true
      }
    });

    if (!ingress) {
      throw new NotFoundException(`Ingress ${ingressId} not found`);
    }

    await this.access.assertProjectAccess(
      ingress.project.id,
      user.id,
      ingress.project.organizationId
    );

    let k8sRoutes: { path: string; serviceName: string; servicePort: number }[] = [];
    try {
      const k8sIngress = await this.mirroredIngress(ingress.namespace, ingress.name);
      const rules = k8sIngress?.spec?.rules ?? [];
      if (rules.length > 0 && rules[0].http?.paths) {
        k8sRoutes = rules[0].http.paths.map((p: any) => ({
          path: p.path || '/',
          serviceName: p.backend?.service?.name || '',
          servicePort: p.backend?.service?.port?.number || 0
        }));
      }
    } catch {
      k8sRoutes = [
        {
          path: ingress.path,
          serviceName: ingress.service?.name || '',
          servicePort: ingress.service?.port || 0
        }
      ];
    }

    return {
      ...scrubIngress(ingress),
      address: ingress.statusAddress,
      routes: k8sRoutes
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
              select: {
                id: true,
                name: true,
                displayName: true,
                status: true,
                services: { include: { ports: true } }
              }
            }
          }
        },
        service: true
      }
    });

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    let access: ProjectAccess;
    try {
      ({ access } = await this.access.assertProjectAccess(
        ingress.project.id,
        user.id,
        ingress.project.organizationId
      ));
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException('Ingress not found');
      }
      throw e;
    }

    let k8sRoutes: { path: string; serviceName: string; servicePort: number }[] = [];
    try {
      const k8sIngress = await this.mirroredIngress(ingress.namespace, ingress.name);
      const rules = k8sIngress?.spec?.rules ?? [];
      if (rules.length > 0 && rules[0].http?.paths) {
        k8sRoutes = rules[0].http.paths.map((p: any) => ({
          path: p.path || '/',
          serviceName: p.backend?.service?.name || '',
          servicePort: p.backend?.service?.port?.number || 0
        }));
      }
    } catch (error) {
      // If we can't read K8s, fall back to DB record
      k8sRoutes = [
        {
          path: ingress.path,
          serviceName: ingress.service?.name || '',
          servicePort: ingress.service?.port || 0
        }
      ];
    }

    // Two enforcement points, one answer: the annotation marks the Cilium
    // Envoy filter, `basic` marks the protection proxy doing the same job.
    const hasBasicAuth =
      ingress.protectionMode === 'basic' ||
      (typeof ingress.annotations === 'object' &&
        ingress.annotations !== null &&
        (ingress.annotations as any)['orchard.my/basic-auth'] === 'true');

    return {
      id: ingress.id,
      name: ingress.name,
      host: ingress.host,
      path: ingress.path,
      tlsEnabled: ingressTlsEnabled(ingress),
      url: ingressPublicUrl(ingress),
      routes: k8sRoutes,
      basicAuthEnabled: hasBasicAuth,
      protectionMode: ingress.protectionMode,
      protectionBypassSecret:
        access.canEdit && ingress.protectionMode !== 'none'
          ? this.crypto.open(ingress.protectionBypassSecret)
          : null,
      protectionBypassPaths: ingress.protectionBypassPaths ?? [],
      project: ingress.project
    };
  }

  async updateProjectIngress(
    projectId: string,
    ingressId: string,
    data: {
      host: string;
      tlsEnabled?: boolean;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      redirectTarget?: string;
      redirectStatus?: number;
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
                ingresses: true
              }
            }
          }
        }
      }
    });

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    const project = ingress.project;

    await this.authz.requireProjectEdit(project.id, user.id, 'manage ingress resources');

    const rawHost = String(data.host || '')
      .trim()
      .toLowerCase();
    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }
    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }
    const hostPattern =
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    if (ingress.redirectTarget) {
      await this.updateProjectRedirectIngress(ingress, project, { ...data, host: rawHost }, user);
      return this.projects.getProject(project.id, clerkId, userData);
    }

    const routes = Array.isArray(data.routes) && data.routes.length > 0 ? data.routes : null;
    if (!routes || routes.length === 0) {
      throw new BadRequestException('At least one route is required');
    }

    const allServices = project.deployments.flatMap((d) =>
      (d.services ?? []).map((s) => ({ ...s, deploymentId: d.id }))
    );

    if (allServices.length === 0) {
      throw new BadRequestException('Project has no services');
    }

    const pathPattern = /^\/[A-Za-z0-9\-._/]*$/;
    const pathBackends: {
      path: string;
      pathType: string;
      serviceName: string;
      servicePort: number;
      serviceId: string;
      deploymentId: string;
    }[] = [];

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

      const targetService = allServices.find(
        (s) => s.name === String(route.serviceName || '').trim()
      );
      if (!targetService) {
        throw new BadRequestException(`Service ${route.serviceName} not found in project`);
      }

      const port = Number(route.servicePort);
      if (!Number.isInteger(port) || port <= 0) {
        throw new BadRequestException(`Invalid service port for ${route.serviceName}`);
      }

      const servicePorts = Array.isArray((targetService as any).ports)
        ? (targetService as any).ports
        : [];
      const hasPort =
        servicePorts.some((p: any) => Number(p.port) === port) ||
        Number(targetService.port) === port;
      if (!hasPort) {
        throw new BadRequestException(`Port ${port} not found on service ${route.serviceName}`);
      }

      pathBackends.push({
        path,
        pathType: 'Prefix',
        serviceName: targetService.name,
        servicePort: port,
        serviceId: targetService.id,
        deploymentId: (targetService as any).deploymentId
      });
    }

    const tlsEnabled = data.tlsEnabled !== false;
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled) {
      if (wildcardSecret) {
        tlsSecretName = wildcardSecret;
      } else if (!tlsSecretName || isWildcardTlsSecret(tlsSecretName)) {
        tlsSecretName = `${OWN_CERT_PREFIX}${randomUUID()}`;
      }
    } else {
      tlsSecretName = null;
    }
    const tlsHosts = tlsSecretName ? [rawHost] : [];
    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;
    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const sanitizedAnnotations: Record<string, string> = {};
    if (tlsEnabled) {
      sanitizedAnnotations['acme.cert-manager.io/http01-edit-in-place'] = 'true';
    }
    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const basicAuthPlan = await this.planBasicAuth(data.basicAuth, 'update');
    const clearBasicAuth = data.basicAuth?.enabled === false;

    let basicAuth;
    if (basicAuthPlan.via === 'cilium') {
      basicAuth = data.basicAuth;
    } else if (clearBasicAuth) {
      basicAuth = { enabled: false, username: '', password: '' };
    }

    try {
      await this.k8sNetwork.updateIngress({
        namespace: ingress.namespace,
        name: ingress.name,
        host: rawHost,
        paths: pathBackends.map((pb) => ({
          path: pb.path,
          pathType: pb.pathType,
          serviceName: pb.serviceName,
          servicePort: pb.servicePort
        })),
        tlsSecretName: tlsSecretName || undefined,
        tlsHosts,
        ingressClassName: TENANT_INGRESS_CLASS,
        entrypoints,
        annotations: sanitizedAnnotations,
        basicAuth
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to update ingress in Kubernetes: ${error.message}`);
    }

    const firstRoute = pathBackends[0];

    await this.syncBasicAuthOnUpdate(ingress, basicAuthPlan, clearBasicAuth, {
      serviceName: firstRoute.serviceName,
      servicePort: firstRoute.servicePort
    });

    await this.prisma.ingress.update({
      where: { id: ingressId },
      data: {
        deploymentId: firstRoute.deploymentId,
        serviceId: firstRoute.serviceId,
        servicePort: firstRoute.servicePort,
        host: rawHost,
        path: firstRoute.path,
        tlsSecretName,
        tlsHosts,
        entrypoints,
        clusterIssuer,
        annotations:
          Object.keys(sanitizedAnnotations).length > 0
            ? (sanitizedAnnotations as Prisma.JsonObject)
            : undefined
      }
    });

    for (const pb of pathBackends) {
      const svc = allServices.find((s) => s.id === pb.serviceId);
      if (svc && !svc.domain) {
        await this.prisma.service.update({
          where: { id: pb.serviceId },
          data: { domain: rawHost }
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
        tls: [Boolean(ingress.tlsSecretName), tlsEnabled]
      }
    });

    return this.projects.getProject(projectId, clerkId, userData);
  }

  private async mirroredIngress(namespace: string, name: string): Promise<any | null> {
    const row = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Ingress', namespace, name },
      select: { manifest: true }
    });
    return row?.manifest ?? null;
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
                organization: true
              }
            }
          }
        }
      }
    });

    if (!ingress || !ingress.deployment) {
      throw new NotFoundException('Ingress not found');
    }

    await this.authz.requireProjectEdit(
      ingress.deployment.project.id,
      user.id,
      'manage ingress resources'
    );

    try {
      await this.k8sNetwork.deleteIngress(ingress.namespace, ingress.name);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    try {
      await this.prisma.ingress.delete({ where: { id: ingressId } });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2025') throw error;
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
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
      targetLabel: ingress.host + ingress.path
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
            organization: true
          }
        }
      }
    });

    if (!ingress || !ingress.project) {
      throw new NotFoundException('Ingress not found');
    }

    await this.authz.requireProjectEdit(ingress.project.id, user.id, 'manage ingress resources');

    const siblings = await this.prisma.ingress.findMany({
      where: {
        namespace: ingress.namespace,
        name: ingress.name,
        id: { not: ingress.id }
      }
    });

    if (siblings.length > 0) {
      try {
        const k8sIngress = await this.k8sNetwork.readIngress(ingress.namespace, ingress.name);
        const remainingPaths = (k8sIngress?.spec?.rules?.[0]?.http?.paths ?? [])
          .filter((p: any) => (p.path || '/') !== ingress.path)
          .map((p: any) => ({
            path: p.path || '/',
            pathType: p.pathType || 'Prefix',
            serviceName: p.backend?.service?.name || '',
            servicePort: p.backend?.service?.port?.number || 0
          }));

        if (remainingPaths.length > 0) {
          const existingAnnotations = (ingress.annotations as Record<string, string> | null) ?? {};
          const existingEntrypoints = Array.isArray(ingress.entrypoints) ? ingress.entrypoints : [];

          await this.k8sNetwork.updateIngress({
            namespace: ingress.namespace,
            name: ingress.name,
            host: ingress.host,
            paths: remainingPaths,
            tlsSecretName: ingress.tlsSecretName || undefined,
            tlsHosts: ingress.tlsHosts ?? [],
            ingressClassName: TENANT_INGRESS_CLASS,
            entrypoints: existingEntrypoints,
            annotations: existingAnnotations
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

    try {
      await this.prisma.ingress.delete({ where: { id: ingressId } });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2025') throw error;
    }

    void this.audit.log({
      action: 'ingress.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: ingress.project.organizationId,
      projectId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: ingress.host + ingress.path,
      metadata: { scope: 'project' }
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
                organization: true
              }
            },
            services: {
              include: {
                ports: true
              }
            },
            ingresses: true
          }
        }
      }
    });

    if (!ingress || !ingress.deployment) {
      throw new NotFoundException('Ingress not found');
    }

    const deployment = ingress.deployment;

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage ingress resources');

    const rawHost = String(data.host || '')
      .trim()
      .toLowerCase();

    if (!rawHost) {
      throw new BadRequestException('Host is required');
    }

    if (rawHost.length > 253) {
      throw new BadRequestException('Host exceeds maximum length');
    }

    const hostPattern =
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

    if (!hostPattern.test(rawHost)) {
      throw new BadRequestException('Host is invalid');
    }

    if (rawHost !== ingress.host) {
      await this.access.assertHostnameAvailable(rawHost, deployment.project.id);
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

    const ingressClassName = TENANT_INGRESS_CLASS;

    const tlsEnabled = data.tlsEnabled !== false;
    const wildcardSecret = wildcardTlsSecretFor(rawHost);
    let tlsSecretName: string | null = ingress.tlsSecretName;
    if (tlsEnabled) {
      if (wildcardSecret) {
        tlsSecretName = wildcardSecret;
      } else if (!tlsSecretName || isWildcardTlsSecret(tlsSecretName)) {
        tlsSecretName = `${OWN_CERT_PREFIX}${randomUUID()}`;
        if (tlsSecretName.length > 255) {
          throw new BadRequestException('TLS secret name is too long');
        }
      }
    } else {
      tlsSecretName = null;
    }

    const clusterIssuer = tlsEnabled && !wildcardSecret ? CERT_CLUSTER_ISSUER : null;

    const entrypoints = tlsEnabled ? ['websecure'] : ['web'];

    const annotationsInput =
      data.annotations && typeof data.annotations === 'object' ? data.annotations : {};

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
    }

    if (clusterIssuer) {
      sanitizedAnnotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const services = Array.isArray(deployment.services) ? deployment.services : [];

    if (services.length === 0) {
      throw new BadRequestException('Deployment has no services to attach');
    }

    const requestedServiceName = String(data.serviceName || '').trim();
    const requestedPort =
      data.servicePort !== undefined && data.servicePort !== null ? Number(data.servicePort) : null;

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
          const ports = Array.isArray((service as any).ports) ? (service as any).ports : [];
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

    let selectedPort = null as {
      port: number;
      targetPort: number;
    } | null;

    if (requestedPort !== null) {
      selectedPort = servicePorts.find((port) => Number(port.port) === requestedPort) || null;
      if (!selectedPort && Number(targetService.port) === requestedPort) {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null && targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port)
        };
      }
    }

    if (!selectedPort) {
      if (servicePorts.length > 0) {
        const firstPort = servicePorts[0];
        selectedPort = {
          port: Number(firstPort.port),
          targetPort:
            firstPort.targetPort !== null && firstPort.targetPort !== undefined
              ? Number(firstPort.targetPort)
              : Number(firstPort.port)
        };
      } else {
        selectedPort = {
          port: Number(targetService.port),
          targetPort:
            targetService.targetPort !== null && targetService.targetPort !== undefined
              ? Number(targetService.targetPort)
              : Number(targetService.port)
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

    const basicAuthPlan = await this.planBasicAuth(data.basicAuth, 'update');
    const clearBasicAuth = data.basicAuth?.enabled === false;

    try {
      let basicAuthConfig;
      if (basicAuthPlan.via === 'cilium') {
        basicAuthConfig = data.basicAuth;
      } else if (clearBasicAuth) {
        basicAuthConfig = { enabled: false, username: '', password: '' };
      }

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
        basicAuth: basicAuthConfig as any
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to update ingress in Kubernetes: ${error.message}`);
    }

    await this.syncBasicAuthOnUpdate(ingress, basicAuthPlan, clearBasicAuth, {
      serviceName: targetService.name,
      servicePort: selectedPort.port
    });

    const annotationsPayload =
      Object.keys(sanitizedAnnotations).length > 0
        ? (sanitizedAnnotations as Prisma.JsonObject)
        : undefined;

    await this.prisma.ingress.update({
      where: { id: ingressId },
      data: {
        serviceId: targetService.id,
        servicePort: selectedPort.port,
        host: rawHost,
        path,
        tlsSecretName,
        tlsHosts,
        entrypoints,
        clusterIssuer,
        annotations: annotationsPayload
      }
    });

    if (!targetService.domain) {
      await this.prisma.service.update({
        where: { id: targetService.id },
        data: {
          domain: rawHost
        }
      });
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        },
        project: {
          include: {
            organization: true
          }
        }
      }
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
      metadata: { host: [ingress.host, rawHost], path: [ingress.path, path] }
    });

    return this.deployments.addInternalUrlsToDeployment(result);
  }

  /**
   * Basic auth has two enforcement points and the cluster decides which. With
   * Cilium it is an Envoy filter bound to the Service, which is stronger: it
   * also covers traffic that never passed the ingress controller. Without it,
   * the same credentials are enforced by the protection proxy, which needs
   * nothing from the CNI. Either way the caller's `basicAuth` request is
   * honoured, so the API behaves the same on a self-hosted k3s box.
   */
  private async planBasicAuth(
    basicAuth: { enabled?: boolean; username?: string; password?: string } | undefined,
    context: 'create' | 'update' = 'create'
  ): Promise<BasicAuthPlan> {
    if (!basicAuth?.enabled) return { via: 'none' };

    const username = String(basicAuth.username || '').trim();
    const password = String(basicAuth.password || '');
    if (!username || !password) {
      // On update, `{ enabled: true }` with no credentials is how a caller says
      // "leave the existing wall alone" while changing something else. On
      // create there is nothing to leave alone, and quietly publishing a host
      // the caller asked to protect is the bug this whole path exists to fix.
      if (context === 'update') return { via: 'none' };
      throw new BadRequestException('Basic auth requires a username and a password');
    }
    if (await this.kubernetesService.isCiliumAvailable()) return { via: 'cilium' };

    // RFC 7617 credentials are colon-delimited, so a colon in the username
    // makes the split ambiguous. The Envoy filter has the same constraint but
    // never validated it.
    if (username.includes(':')) {
      throw new BadRequestException('Basic auth username cannot contain a colon');
    }
    return { via: 'proxy', username, passwordHash: await bcrypt.hash(password, 10) };
  }

  /**
   * Repoint an already-created Ingress at the protection proxy and record the
   * credentials. Throws if the repoint did not take: unlike the reconciler-
   * backed modes, a caller who asked for a password must not be told the host
   * is protected while it still serves the app directly.
   *
   * The host is public for the moment between `createIngress` and this call.
   * The Cilium path has no such window, since the Envoy filter is installed
   * before the Ingress exists.
   */
  private async enableProxyBasicAuth(
    namespace: string,
    ingressName: string,
    plan: { username: string; passwordHash: string }
  ): Promise<void> {
    const result = await this.k8sNetwork.enableProtectionProxy(namespace, ingressName);
    if (result !== 'applied') {
      throw new BadRequestException(
        'Could not put this domain behind basic auth, so it would be served without a password. ' +
          'Nothing was created; try again in a moment.'
      );
    }

    await this.prisma.ingress.updateMany({
      where: { namespace, name: ingressName },
      data: {
        protectionMode: 'basic',
        protectionUsername: plan.username,
        protectionPasswordHash: plan.passwordHash,
        protectionBypassSecret: this.crypto.seal(randomBytes(32).toString('hex'))
      }
    });
  }

  /**
   * Called after `updateIngress`, which rewrites every path backend to the app
   * itself. Any host that was behind the protection proxy is served directly
   * from that moment until something puts it back, so re-applying here rather
   * than waiting out the ten-minute reconciler is the difference between a
   * blip and ten minutes of an unprotected host.
   */
  private async syncBasicAuthOnUpdate(
    ingress: { id: string; namespace: string; name: string; protectionMode: IngressProtectionMode },
    plan: BasicAuthPlan,
    disableRequested: boolean,
    upstream: { serviceName: string; servicePort: number } | null
  ): Promise<void> {
    if (plan.via === 'proxy') {
      await this.enableProxyBasicAuth(ingress.namespace, ingress.name, plan);
      return;
    }

    if (disableRequested && ingress.protectionMode === 'basic') {
      if (upstream) {
        await this.k8sNetwork.disableProtectionProxy(
          ingress.namespace,
          ingress.name,
          upstream.serviceName,
          upstream.servicePort
        );
      }
      await this.prisma.ingress.update({
        where: { id: ingress.id },
        data: {
          protectionMode: 'none',
          protectionUsername: null,
          protectionPasswordHash: null,
          protectionBypassSecret: null
        }
      });
      return;
    }

    if (ingress.protectionMode === 'none') return;

    const result = await this.k8sNetwork.enableProtectionProxy(ingress.namespace, ingress.name);
    if (result === 'applied') return;

    if (ingress.protectionMode === 'basic') {
      throw new BadRequestException(
        'The ingress was updated but could not be put back behind basic auth, so it is currently ' +
          'served without a password. Retry the update, or the reconciler will restore it within 10 minutes.'
      );
    }
    this.logger.error(
      `Protection proxy not re-applied to ${ingress.namespace}/${ingress.name} after update (${result}); ` +
        'the reconciler will retry within 10 minutes'
    );
  }

  async updateIngressProtection(
    projectId: string,
    ingressId: string,
    userId: string,
    mode: IngressProtectionMode,
    password?: string,
    bypassPaths?: string[],
    username?: string
  ) {
    await this.authz.requireProjectEdit(projectId, userId, 'manage ingress protection');

    if (mode === 'orchard' && !ORCHARD_LOGIN_PROTECTION_ENABLED) {
      throw new BadRequestException(
        '"Sign in with Orchard" protection is disabled on this instance. ' +
          'Use basic auth or a shared password instead, or set protection.orchardLogin=true in the chart.'
      );
    }

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, projectId },
      include: {
        service: { include: { ports: true } },
        project: { include: { organization: true } }
      }
    });

    if (!ingress) throw new NotFoundException('Ingress not found');
    if (ingress.redirectTarget) {
      throw new BadRequestException('Access protection is not available for redirect domains');
    }

    const wasProtected = ingress.protectionMode !== 'none';
    const willProtect = mode !== 'none';

    let protectionPasswordHash: string | null = null;
    let protectionUsername: string | null = null;
    let protectionBypassSecret = this.crypto.open(ingress.protectionBypassSecret);

    if (mode === 'password') {
      if (!password) throw new BadRequestException('Password is required for password protection');
      protectionPasswordHash = await bcrypt.hash(password, 10);
    }

    if (mode === 'basic') {
      const cleanUsername = String(username || '').trim();
      if (!cleanUsername) throw new BadRequestException('Username is required for basic auth');
      if (!password) throw new BadRequestException('Password is required for basic auth');
      // RFC 7617 credentials are colon-delimited, so a colon in the username
      // makes the split ambiguous and the account unusable.
      if (cleanUsername.includes(':')) {
        throw new BadRequestException('Basic auth username cannot contain a colon');
      }
      protectionUsername = cleanUsername;
      protectionPasswordHash = await bcrypt.hash(password, 10);
    }

    if (willProtect && !protectionBypassSecret) {
      protectionBypassSecret = randomBytes(32).toString('hex');
    }

    if (!willProtect) {
      protectionBypassSecret = null;
      protectionPasswordHash = null;
      protectionUsername = null;
    }

    let normalizedBypassPaths = ingress.protectionBypassPaths;
    if (bypassPaths !== undefined) {
      if (!Array.isArray(bypassPaths)) {
        throw new BadRequestException('Bypass paths must be a list');
      }
      if (bypassPaths.length > 20) {
        throw new BadRequestException('At most 20 bypass paths are allowed');
      }
      const seen = new Set<string>();
      for (const raw of bypassPaths) {
        const normalized = normalizeBypassPath(raw);
        if (!normalized) {
          throw new BadRequestException(
            `Invalid bypass path: ${String(raw)}. Paths must start with / and cannot be / itself.`
          );
        }
        seen.add(normalized);
      }
      normalizedBypassPaths = Array.from(seen);
    }
    if (!willProtect) {
      normalizedBypassPaths = [];
    }

    if (wasProtected && !willProtect) {
      const serviceName = ingress.service?.name;
      const servicePort = ingress.service?.ports?.[0]?.port || ingress.service?.port;
      if (serviceName && servicePort) {
        await this.k8sNetwork.disableProtectionProxy(
          ingress.namespace,
          ingress.name,
          serviceName,
          Number(servicePort)
        );
      }
    }

    if (willProtect) {
      const result = await this.k8sNetwork.enableProtectionProxy(ingress.namespace, ingress.name);
      if (result === 'failed') {
        // Saying "protected" while the app is still served directly is the one
        // outcome worth failing the request over. The 10-minute reconciler
        // would eventually fix it, but the user should not be told it is done.
        throw new BadRequestException(
          'Could not put this domain behind the auth wall, so it is still served directly. ' +
            'The protection setting was not saved; try again in a moment.'
        );
      }
    }

    const annotations = (ingress.annotations as Record<string, string>) || {};
    if (willProtect) {
      annotations['orchard.my/protection'] = mode;
    } else {
      delete annotations['orchard.my/protection'];
    }

    await this.prisma.ingress.update({
      where: { id: ingressId },
      data: {
        protectionMode: mode,
        protectionUsername,
        protectionPasswordHash,
        protectionBypassSecret: this.crypto.seal(protectionBypassSecret),
        protectionBypassPaths: normalizedBypassPaths,
        annotations: annotations as Prisma.JsonObject
      }
    });

    void this.audit.log({
      action: willProtect ? 'ingress.protection.enabled' : 'ingress.protection.disabled',
      actorUserId: userId,
      organizationId: ingress.project.organizationId,
      projectId,
      targetType: 'ingress',
      targetId: ingressId,
      targetLabel: ingress.host,
      metadata: { mode }
    });

    return {
      protectionMode: mode,
      protectionBypassSecret: willProtect ? protectionBypassSecret : null,
      protectionBypassPaths: normalizedBypassPaths
    };
  }

  async getIngressProtection(projectId: string, ingressId: string, userId: string) {
    await this.authz.requireProjectEdit(projectId, userId, 'view ingress protection');

    const ingress = await this.prisma.ingress.findFirst({
      where: { id: ingressId, projectId },
      select: {
        host: true,
        protectionMode: true,
        protectionUsername: true,
        protectionBypassSecret: true,
        project: { select: { organizationId: true } }
      }
    });

    if (!ingress) throw new NotFoundException('Ingress not found');

    if (ingress.protectionMode !== 'none' && ingress.protectionBypassSecret) {
      void this.audit.log({
        action: 'ingress.protection.secret.revealed',
        actorUserId: userId,
        organizationId: ingress.project.organizationId,
        projectId,
        targetType: 'ingress',
        targetId: ingressId,
        targetLabel: ingress.host
      });
    }

    return {
      protectionMode: ingress.protectionMode,
      protectionUsername: ingress.protectionMode === 'basic' ? ingress.protectionUsername : null,
      protectionBypassSecret:
        ingress.protectionMode !== 'none' ? this.crypto.open(ingress.protectionBypassSecret) : null
    };
  }
}
