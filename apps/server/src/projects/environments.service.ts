import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { QuotasService } from '../quotas/quotas.service';
import { AuditService } from '../audit/audit.service';
import { OrgEventsService } from '../events/org-events.service';
import { assertDeleteConfirmation, formatSlug } from './projects.utils';
import { RegistryCredentialsService } from './registry-credentials.service';
import { NamespaceTeardownService } from './namespace-teardown.service';

const RESERVED_NAMESPACES = new Set<string>([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'default',
  'orchard',
  'orchard-builders',
  'orchard-r2-proxy',
  'harbor',
  'postgresql',
  'network',
  'longhorn-system',
  'flux-system',
  'monitoring',
  'cert-manager',
  ...(process.env.RESERVED_NAMESPACES_EXTRA || '')
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean)
]);

@Injectable()
export class EnvironmentsService {
  private readonly logger = new Logger(EnvironmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sNamespace: K8sNamespaceService,
    private readonly quotas: QuotasService,
    private readonly audit: AuditService,
    private readonly orgEvents: OrgEventsService,
    private readonly registryCredentials: RegistryCredentialsService,
    private readonly teardown: NamespaceTeardownService
  ) {}

  async listEnvironments(projectId: string) {
    return this.prisma.environment.findMany({
      where: { projectId },
      orderBy: [{ isProduction: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { deployments: true, databases: true, ingresses: true } } }
    });
  }

  /**
   * Resolve the environment a resource create should land in: the explicit id
   * (validated to belong to the project) or the project's default environment.
   * The back-compat shim so create endpoints that omit environmentId keep
   * landing in production.
   */
  async resolveEnvironment(projectId: string, environmentId?: string | null) {
    if (environmentId) {
      const env = await this.prisma.environment.findUnique({ where: { id: environmentId } });
      if (!env || env.projectId !== projectId) {
        throw new BadRequestException('Environment does not belong to this project');
      }
      return env;
    }
    const def = await this.prisma.environment.findFirst({
      where: { projectId, isDefault: true },
      orderBy: { isProduction: 'desc' }
    });
    if (def) return def;
    // Legacy safety: a project with no environment row yet — synthesize the
    // prod env from the project namespace so nothing 500s mid-rollout.
    return this.ensureDefaultEnvironment(projectId);
  }

  /**
   * Idempotently guarantee a project has a default production environment.
   * Used by createProject and as a self-heal for any project the retrofit
   * missed.
   */
  async ensureDefaultEnvironment(projectId: string) {
    const existing = await this.prisma.environment.findFirst({
      where: { projectId, isDefault: true }
    });
    if (existing) return existing;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, namespace: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    return this.prisma.environment.create({
      data: {
        projectId,
        name: 'Production',
        slug: 'production',
        namespace: project.namespace,
        isDefault: true,
        isProduction: true
      }
    });
  }

  private buildEnvNamespace(parts: string[]): string {
    const sanitized = parts.map((p) => formatSlug(p)).filter((p) => p.length > 0);
    const namespace = sanitized.join('-').substring(0, 63);
    if (!namespace) throw new BadRequestException('Failed to build namespace');
    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new ConflictException('This environment name is not available');
    }
    return namespace;
  }

  private async deconflictNamespace(base: string[]): Promise<string> {
    const baseSlug = base[base.length - 1];
    let attempt = 0;
    let namespace = this.buildEnvNamespace(base);
    while (true) {
      const [envUse, projUse] = await Promise.all([
        this.prisma.environment.findFirst({ where: { namespace }, select: { id: true } }),
        this.prisma.project.findFirst({ where: { namespace }, select: { id: true } })
      ]);
      if (!envUse && !projUse) return namespace;
      attempt += 1;
      namespace = this.buildEnvNamespace([...base.slice(0, -1), `${baseSlug}-${attempt}`]);
    }
  }

  async createEnvironment(
    projectId: string,
    input: { name: string; slug?: string },
    userId: string
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        slug: true,
        organizationId: true,
        organization: { select: { slug: true } }
      }
    });
    if (!project) throw new NotFoundException('Project not found');

    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException('Environment name is required');
    const slug = formatSlug(input.slug || name);
    if (!slug) throw new BadRequestException('Environment slug cannot be empty');

    const slugClash = await this.prisma.environment.findUnique({
      where: { projectId_slug: { projectId, slug } },
      select: { id: true }
    });
    if (slugClash) throw new ConflictException(`An environment "${slug}" already exists`);

    const namespace = await this.deconflictNamespace([
      project.organization.slug,
      project.slug,
      slug
    ]);

    const nsResult = await this.k8sNamespace.createNamespace(namespace);
    if (!nsResult.created) {
      throw new ConflictException('Kubernetes namespace already exists');
    }

    let env;
    try {
      env = await this.prisma.environment.create({
        data: { projectId, name, slug, namespace, isDefault: false, isProduction: false }
      });
    } catch (err) {
      await this.k8sNamespace.deleteNamespace(namespace).catch(() => {});
      throw err;
    }

    await this.quotas
      .applyProjectQuota(projectId)
      .catch((e) => this.logger.warn(`applyProjectQuota after env create failed: ${e?.message}`));
    await this.registryCredentials
      .syncNamespace(projectId, namespace)
      .catch((e) =>
        this.logger.warn(`registry secret sync after env create failed: ${e?.message}`)
      );
    await this.k8sNamespace
      .applyProjectDatabaseIngress(projectId)
      .catch((e) => this.logger.warn(`database ingress after env create failed: ${e?.message}`));

    this.emitChanged(project.organizationId, projectId, env.id);
    void this.audit.log({
      action: 'environment.created',
      actorUserId: userId,
      organizationId: project.organizationId,
      projectId,
      targetType: 'environment',
      targetId: env.id,
      targetLabel: env.name,
      metadata: { slug: env.slug, namespace: env.namespace }
    });
    return env;
  }

  async renameEnvironment(environmentId: string, name: string, userId: string) {
    const env = await this.getEnvOrThrow(environmentId);
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Environment name is required');
    const updated = await this.prisma.environment.update({
      where: { id: environmentId },
      data: { name: trimmed }
    });
    this.emitChanged(env.project.organizationId, env.projectId, env.id);
    void this.audit.log({
      action: 'environment.renamed',
      actorUserId: userId,
      organizationId: env.project.organizationId,
      projectId: env.projectId,
      targetType: 'environment',
      targetId: env.id,
      targetLabel: trimmed
    });
    return updated;
  }

  async setDefaultEnvironment(environmentId: string, userId: string) {
    const env = await this.getEnvOrThrow(environmentId);
    await this.prisma.$transaction([
      this.prisma.environment.updateMany({
        where: { projectId: env.projectId, isDefault: true },
        data: { isDefault: false }
      }),
      this.prisma.environment.update({ where: { id: environmentId }, data: { isDefault: true } })
    ]);
    this.emitChanged(env.project.organizationId, env.projectId, env.id);
    void this.audit.log({
      action: 'environment.default_changed',
      actorUserId: userId,
      organizationId: env.project.organizationId,
      projectId: env.projectId,
      targetType: 'environment',
      targetId: env.id,
      targetLabel: env.name
    });
    return this.prisma.environment.findUnique({ where: { id: environmentId } });
  }

  async deleteEnvironment(
    environmentId: string,
    actor: { userId: string; email?: string },
    confirmName: unknown
  ) {
    const env = await this.getEnvOrThrow(environmentId);
    if (env.isDefault || env.isProduction) {
      throw new BadRequestException('The default production environment cannot be deleted');
    }
    const count = await this.prisma.environment.count({ where: { projectId: env.projectId } });
    if (count <= 1) {
      throw new BadRequestException('A project must have at least one environment');
    }
    assertDeleteConfirmation(env.name, confirmName, 'environment');
    return this.destroyEnvironment(env, actor, {});
  }

  async deleteEnvironmentFromCluster(
    environmentId: string,
    cause: { reason: string; source: string; namespace: string }
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, organizationId: true, namespace: true } } }
    });
    if (!env) return null;
    const result = await this.destroyEnvironment(env, null, cause);
    if (env.isDefault) {
      await this.prisma.environment.updateMany({
        where: { projectId: env.projectId, namespace: env.project.namespace },
        data: { isDefault: true }
      });
    }
    return result;
  }

  private async destroyEnvironment(
    env: {
      id: string;
      projectId: string;
      name: string;
      slug: string;
      namespace: string;
      project: { organizationId: string };
    },
    actor: { userId: string; email?: string } | null,
    cause: Record<string, unknown>
  ) {
    const summary = await this.teardown.teardown({
      projectId: env.projectId,
      organizationId: env.project.organizationId,
      environmentId: env.id,
      namespace: env.namespace,
      reason: 'environment.deleted',
      actor: actor ?? { userId: undefined },
      keepData: actor === null
    });
    await this.k8sNamespace
      .deleteNamespace(env.namespace)
      .catch((e) => this.logger.warn(`deleteNamespace(${env.namespace}) failed: ${e?.message}`));
    await this.prisma.environment.deleteMany({ where: { id: env.id } });
    await this.k8sNamespace
      .applyProjectDatabaseIngress(env.projectId)
      .catch((e) => this.logger.warn(`database ingress after env delete failed: ${e?.message}`));

    this.emitChanged(env.project.organizationId, env.projectId, env.id);
    void this.audit.log({
      action: 'environment.deleted',
      actorUserId: actor?.userId,
      actorEmail: actor?.email,
      organizationId: env.project.organizationId,
      projectId: env.projectId,
      targetType: 'environment',
      targetId: env.id,
      targetLabel: env.name,
      metadata: { slug: env.slug, namespace: env.namespace, ...cause, ...summary }
    });
    return { success: true, ...summary };
  }

  async projectIdForEnv(environmentId: string): Promise<string> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { projectId: true }
    });
    if (!env) throw new NotFoundException('Environment not found');
    return env.projectId;
  }

  private async getEnvOrThrow(environmentId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, organizationId: true } } }
    });
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  private emitChanged(organizationId: string, projectId: string, environmentId: string) {
    this.orgEvents.emit({
      organizationId,
      type: 'environment.changed',
      id: environmentId,
      projectId
    });
  }
}
