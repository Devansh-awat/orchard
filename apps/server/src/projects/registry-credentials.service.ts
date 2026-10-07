import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { BlockedDestinationError, guardedFetch } from '../notifications/webhook-guard';
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
    const rows = await this.prisma.registryCredential.findMany({
      where: { projectId },
      select: { registry: true }
    });
    return rows.map((r) => r.registry);
  }

  async pullSecretsFor(projectId: string, image: string): Promise<{ name: string }[]> {
    return pullSecretsForImage(image, await this.registriesFor(projectId));
  }

  async upsert(
    projectId: string,
    input: RegistryCredentialInput,
    userId: string
  ): Promise<RegistryCredentialView> {
    const registry = normalizeRegistryHost(input?.registry ?? '');
    if (!registry) {
      throw new BadRequestException('Registry must be a hostname like ghcr.io or docker.io');
    }
    const username = String(input?.username ?? '').trim();
    const password = String(input?.password ?? '');
    if (!username || username.length > MAX_USERNAME_LEN) {
      throw new BadRequestException('Username is required');
    }
    if (!password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      throw new BadRequestException('Password or token is required');
    }

    if (!this.crypto.enabled) {
      throw new BadRequestException(
        'This instance has no SECRETS_ENCRYPTION_KEY, so registry tokens cannot be stored encrypted. Ask the operator to set one.'
      );
    }

    await this.verify(registry, username, password);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true }
    });
    if (!project) throw new NotFoundException('Project not found');

    const row = await this.prisma.registryCredential.upsert({
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

    await this.syncProject(projectId);

    void this.audit.log({
      action: 'project.registry_credential.set',
      actorUserId: userId,
      organizationId: project.organizationId,
      projectId,
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

  private async authsFor(projectId: string) {
    const rows = await this.prisma.registryCredential.findMany({
      where: { projectId },
      select: { registry: true, username: true, password: true }
    });
    if (rows.length === 0) return null;
    return registryAuthsFor(
      rows.map((r) => ({ ...r, password: this.crypto.open(r.password) ?? '' }))
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
          'That registry resolves to an internal address. Self-hosters can allow this with REGISTRY_CREDENTIALS_ALLOW_INTERNAL=true.'
        );
      }
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Could not reach the registry: ${err?.cause?.message ?? err?.message ?? 'network error'}`
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
        `The registry answered HTTP ${probe.status} to /v2/; is ${registry} a container registry?`
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
