import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { mergeRegistryAuths, pullAuthsFromEnv } from '../docker/registry-pull-auth';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { BlockedDestinationError, guardedFetch } from '../notifications/webhook-guard';
import { inspectImagePorts, type ImagePorts, type RegistryCredential } from './image-ports';
import {
  REGISTRY_PULL_SECRET_NAME,
  bearerTokenUrl,
  normalizeRegistryHost,
  parseBearerChallenge,
  pullSecretsForImage,
  registryApiBase,
  registryAuthsFor
} from './registry-credentials';

const MAX_USERNAME_LEN = 255;
const MAX_PASSWORD_BYTES = 16 * 1024;
const VERIFY_TIMEOUT_MS = 10_000;

export interface RegistryCredentialInput {
  registry: string;
  username: string;
  password: string;
}

export interface RegistryCredentialView {
  id: string;
  registry: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class RegistryCredentialsService {
  private readonly logger = new Logger(RegistryCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly crypto: SecretCryptoService,
    private readonly audit: AuditService
  ) {}

  async list(projectId: string): Promise<RegistryCredentialView[]> {
    return this.prisma.registryCredential.findMany({
      where: { projectId },
      orderBy: { registry: 'asc' },
      select: { id: true, registry: true, username: true, createdAt: true, updatedAt: true }
    });
  }

  async registriesFor(projectId: string): Promise<string[]> {
    return Object.keys((await this.authsFor(projectId)) ?? {});
  }

  async listOrganization(organizationId: string): Promise<RegistryCredentialView[]> {
    return this.prisma.organizationRegistryCredential.findMany({
      where: { organizationId },
      orderBy: { registry: 'asc' },
      select: { id: true, registry: true, username: true, createdAt: true, updatedAt: true }
    });
  }

  async syncOrganization(organizationId: string): Promise<void> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: { id: true }
    });
    for (const project of projects) await this.syncProject(project.id);
  }

  async buildAuths(deploymentId: string | undefined, env: Record<string, string>) {
    const overrides = registryAuthsFor(
      Object.entries(pullAuthsFromEnv(env)).map(([host, auth]) => ({
        registry: normalizeRegistryHost(host) ?? host,
        username: auth.username,
        password: auth.password
      }))
    );
    if (!deploymentId) return overrides;
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    return mergeRegistryAuths((await this.authsFor(deployment.projectId)) ?? {}, overrides);
  }

  async pullSecretsFor(projectId: string, image: string): Promise<{ name: string }[]> {
    return pullSecretsForImage(image, await this.registriesFor(projectId));
  }

  async upsert(
    projectId: string,
    input: RegistryCredentialInput,
    userId: string,
    organizationScope = false
  ): Promise<RegistryCredentialView> {
    const registry = normalizeRegistryHost(
      typeof input?.registry === 'string' ? input.registry : ''
    );
    if (!registry) {
      throw new BadRequestException('Registry must be a hostname like ghcr.io or docker.io');
    }
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!username || username.length > MAX_USERNAME_LEN) {
      throw new BadRequestException('Username is required');
    }
    if (!password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      throw new BadRequestException('Password or token is required');
    }

    if (!this.crypto.enabled) {
      throw new BadRequestException(
        "This instance has no SECRETS_ENCRYPTION_KEY, so Orchard can't store registry tokens encrypted. Ask an instance admin to set one."
      );
    }

    await this.verify(registry, username, password);

    const project = organizationScope
      ? { organizationId: projectId }
      : await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, organizationId: true }
        });
    if (!project) throw new NotFoundException('Project not found');

    const row = organizationScope
      ? await this.prisma.organizationRegistryCredential.upsert({
          where: { organizationId_registry: { organizationId: projectId, registry } },
          create: {
            organizationId: projectId,
            registry,
            username,
            password: this.crypto.encrypt(password),
            createdBy: userId
          },
          update: { username, password: this.crypto.encrypt(password) },
          select: { id: true, registry: true, username: true, createdAt: true, updatedAt: true }
        })
      : await this.prisma.registryCredential.upsert({
          where: { projectId_registry: { projectId, registry } },
          create: {
            projectId,
            registry,
            username,
            password: this.crypto.seal(password),
            createdBy: userId
          },
          update: { username, password: this.crypto.seal(password) },
          select: { id: true, registry: true, username: true, createdAt: true, updatedAt: true }
        });

    if (organizationScope) await this.syncOrganization(projectId);
    else await this.syncProject(projectId);

    void this.audit.log({
      action: organizationScope ? 'org.registry_credential.set' : 'project.registry_credential.set',
      actorUserId: userId,
      organizationId: project.organizationId,
      projectId: organizationScope ? undefined : projectId,
      targetType: 'registry_credential',
      targetId: row.id,
      targetLabel: registry,
      metadata: { registry, username }
    });
    return row;
  }

  async remove(projectId: string, id: string, userId: string): Promise<{ success: true }> {
    const row = await this.prisma.registryCredential.findFirst({
      where: { id, projectId },
      select: {
        id: true,
        registry: true,
        username: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!row) throw new NotFoundException('Registry credential not found');

    await this.prisma.registryCredential.delete({ where: { id: row.id } });
    await this.syncProject(projectId);

    void this.audit.log({
      action: 'project.registry_credential.removed',
      actorUserId: userId,
      organizationId: row.project.organizationId,
      projectId,
      targetType: 'registry_credential',
      targetId: row.id,
      targetLabel: row.registry,
      metadata: { registry: row.registry, username: row.username }
    });
    return { success: true };
  }

  async removeOrganization(organizationId: string, id: string, userId: string) {
    const row = await this.prisma.organizationRegistryCredential.findFirst({
      where: { id, organizationId },
      select: { id: true, registry: true }
    });
    if (!row) throw new NotFoundException('Registry credential not found');
    await this.prisma.organizationRegistryCredential.delete({ where: { id: row.id } });
    await this.syncOrganization(organizationId);
    void this.audit.log({
      action: 'org.registry_credential.removed',
      actorUserId: userId,
      organizationId,
      targetType: 'registry_credential',
      targetId: row.id,
      targetLabel: row.registry
    });
    return { success: true };
  }

  async syncNamespace(projectId: string, namespace: string): Promise<void> {
    const auths = await this.authsFor(projectId);
    await this.k8sWorkload.upsertDockerConfigSecret(namespace, REGISTRY_PULL_SECRET_NAME, auths);
  }

  async syncProject(projectId: string): Promise<void> {
    const [auths, environments, deployments] = await Promise.all([
      this.authsFor(projectId),
      this.prisma.environment.findMany({ where: { projectId }, select: { namespace: true } }),
      this.prisma.deployment.findMany({
        where: { projectId },
        select: { id: true, name: true, namespace: true, image: true }
      })
    ]);

    for (const env of environments) {
      try {
        await this.k8sWorkload.upsertDockerConfigSecret(
          env.namespace,
          REGISTRY_PULL_SECRET_NAME,
          auths
        );
      } catch (err: any) {
        this.logger.warn(
          `registry pull secret sync failed for ${env.namespace}: ${err?.message ?? err}`
        );
      }
    }

    const registries = await this.registriesFor(projectId);
    await Promise.allSettled(
      deployments.map(async (dep) => {
        if (!dep.image) return;
        const wanted = pullSecretsForImage(dep.image, registries).length > 0;
        let current: string[];
        try {
          current = await this.k8sWorkload.readDeploymentPullSecrets(dep.name, dep.namespace);
        } catch {
          return;
        }
        const has = current.includes(REGISTRY_PULL_SECRET_NAME);
        if (has === wanted) return;
        const next = current
          .filter((n) => n !== REGISTRY_PULL_SECRET_NAME)
          .map((name) => ({ name }));
        if (wanted) next.push({ name: REGISTRY_PULL_SECRET_NAME });
        try {
          await this.k8sWorkload.updateDeploymentPullSecrets(dep.name, dep.namespace, next);
        } catch (err: any) {
          this.logger.warn(
            `imagePullSecrets update failed for ${dep.namespace}/${dep.name}: ${err?.message ?? err}`
          );
        }
      })
    );
  }

  async applyToDeployment(
    projectId: string,
    deployment: { name: string; namespace: string },
    image: string
  ): Promise<void> {
    const wanted = await this.pullSecretsFor(projectId, image);
    let current: string[];
    try {
      current = await this.k8sWorkload.readDeploymentPullSecrets(
        deployment.name,
        deployment.namespace
      );
    } catch {
      return;
    }
    const has = current.includes(REGISTRY_PULL_SECRET_NAME);
    if (has === wanted.length > 0) return;
    const next = current.filter((n) => n !== REGISTRY_PULL_SECRET_NAME).map((name) => ({ name }));
    await this.k8sWorkload.updateDeploymentPullSecrets(deployment.name, deployment.namespace, [
      ...next,
      ...wanted
    ]);
  }

  async pullCredential(
    scope: { projectId: string } | { organizationId: string },
    registry: string
  ): Promise<RegistryCredential | null> {
    let organizationId: string | null = null;
    if ('projectId' in scope) {
      const own = await this.prisma.registryCredential.findFirst({
        where: { projectId: scope.projectId, registry },
        select: { username: true, password: true }
      });
      const password = own ? this.crypto.open(own.password) : null;
      if (own && password) return { username: own.username, password };
      const project = await this.prisma.project.findUnique({
        where: { id: scope.projectId },
        select: { organizationId: true }
      });
      organizationId = project?.organizationId ?? null;
    } else {
      organizationId = scope.organizationId;
    }
    if (!organizationId) return null;
    const inherited = await this.prisma.organizationRegistryCredential.findFirst({
      where: { organizationId, registry },
      select: { username: true, password: true }
    });
    const password = inherited ? this.crypto.open(inherited.password) : null;
    return inherited && password ? { username: inherited.username, password } : null;
  }

  detectImagePorts(
    image: unknown,
    scope: { projectId: string } | { organizationId: string }
  ): Promise<ImagePorts> {
    return inspectImagePorts(image, {
      credentialFor: (registry) => this.pullCredential(scope, registry),
      onFailure: (reason, registry) =>
        this.logger.debug(`image port detection on ${registry ?? 'no registry'}: ${reason}`)
    });
  }

  private async authsFor(projectId: string) {
    const rows = await this.prisma.registryCredential.findMany({
      where: { projectId },
      select: { registry: true, username: true, password: true }
    });
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    const inherited = await this.prisma.organizationRegistryCredential.findMany({
      where: { organizationId: project.organizationId },
      select: { registry: true, username: true, password: true }
    });
    if (rows.length === 0 && inherited.length === 0) return null;
    return registryAuthsFor(
      [...inherited, ...rows].map((r) => ({ ...r, password: this.crypto.open(r.password) ?? '' }))
    );
  }

  private allowInternal(): boolean {
    return (process.env.REGISTRY_CREDENTIALS_ALLOW_INTERNAL || '').toLowerCase() === 'true';
  }

  private async fetchRegistry(url: string, headers: Record<string, string>) {
    try {
      return await guardedFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        allowPrivate: this.allowInternal(),
        label: 'Registry',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
      });
    } catch (err: any) {
      if (err instanceof BlockedDestinationError) {
        throw new BadRequestException(
          'That registry resolves to an internal address. To allow this, set REGISTRY_CREDENTIALS_ALLOW_INTERNAL=true.'
        );
      }
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Couldn't reach the registry: ${err?.cause?.message ?? err?.message ?? 'network error'}`
      );
    }
  }

  private async verify(registry: string, username: string, password: string): Promise<void> {
    const basic = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const base = registryApiBase(registry);
    const probe = await this.fetchRegistry(`${base}/v2/`, {});
    await probe.body?.cancel();

    if (probe.status === 200) return;
    if (probe.status !== 401) {
      throw new BadRequestException(
        `The registry answered HTTP ${probe.status} to /v2/. Check that ${registry} is a container registry.`
      );
    }

    const challenge = parseBearerChallenge(probe.headers.get('www-authenticate'));
    const target = challenge ? bearerTokenUrl(challenge) : `${base}/v2/`;

    const res = await this.fetchRegistry(target, { authorization: basic });
    await res.body?.cancel();
    if (res.status === 200) return;
    if (res.status === 401 || res.status === 403) {
      throw new BadRequestException(`${registry} rejected that username and password`);
    }
    throw new BadRequestException(
      `${registry} answered HTTP ${res.status} while checking the credentials`
    );
  }
}
