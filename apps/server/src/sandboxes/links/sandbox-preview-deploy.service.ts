import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { SandboxConversation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../auth/authorization.service';
import { AuditService } from '../../audit/audit.service';
import { SecretCryptoService } from '../../crypto/secret-crypto.service';
import { referencedResourceRefs, resolveEnvVars, type EnvVar } from '../../env/env-resolver';
import type { DeploymentsService } from '../../projects/deployments.service';
import type { EnvironmentsService } from '../../projects/environments.service';
import type { IngressService } from '../../projects/ingress.service';
import { SandboxNotRunningError } from '../runners/sandbox-runner';
import { SandboxWorkspaceService, type WorkspaceSandbox } from '../sandbox-workspace.service';
import { SandboxSessionsService, type SessionDto } from '../sandbox-sessions.service';
import { WORKTREES_ROOT, isUuid, isValidGitRef, isWorktreePath } from '../sandbox-session-commands';
import {
  isPreviewEnvSlug,
  normalizeGithubRepo,
  previewEnvSlug,
  previewUrlOf,
  type PreviewIngressRow
} from './preview-state';

export interface PreviewSandbox extends WorkspaceSandbox {
  name: string;
  organizationId: string | null;
}

export interface PreviewActor {
  id: string;
  email?: string | null;
  clerkId: string;
}

export interface PreviewDeployResult {
  session: SessionDto;
  deploymentId: string;
  environmentId: string;
  url: string | null;
  branch: string;
  commit: string | null;
  redeployed: boolean;
  skippedEnv: string[];
}

export interface PreviewProjectServices {
  deployments: Pick<DeploymentsService, 'createDeploymentFromGitHub' | 'rebuildDeployment'>;
  environments: Pick<
    EnvironmentsService,
    'createEnvironment' | 'deleteEnvironment' | 'deleteEnvironmentFromCluster'
  >;
  ingress: Pick<IngressService, 'createAutoIngressForDeployment'>;
}

const SOURCE_INCLUDE = {
  environment: { select: { id: true, slug: true, isDefault: true, isProduction: true } },
  envVars: { select: { key: true, value: true, secret: true } },
  volumes: true,
  services: { include: { ports: true }, orderBy: { createdAt: 'asc' as const } }
} as const;

const HEAD_RE = /^[0-9a-f]{40}$/;

export function parsePushedHead(stdout: string): {
  commit: string | null;
  branch: string | null;
  repo: string | null;
} {
  const [commit = '', branch = '', remote = ''] = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim());
  return {
    commit: HEAD_RE.test(commit) ? commit : null,
    branch: branch && branch !== 'HEAD' && isValidGitRef(branch) ? branch : null,
    repo: normalizeGithubRepo(remote)
  };
}

export function cloneEnv(
  own: EnvVar[],
  shared: EnvVar[]
): { env: { key: string; value: string; secret: boolean }[]; skipped: string[] } {
  const skipped = own.filter((v) => referencedResourceRefs([v]).length > 0).map((v) => v.key);
  const kept = own.filter((v) => !skipped.includes(v.key));
  const { resolved } = resolveEnvVars(kept, shared, {});
  const secretKeys = resolved.filter((v) => v.secret).map((v) => v.key);
  return {
    env: resolved
      .filter((v) => !v.secret)
      .map((v) => ({ key: v.key, value: v.value, secret: false })),
    skipped: [...skipped, ...secretKeys]
  };
}

@Injectable()
export class SandboxPreviewDeployService implements OnModuleInit {
  private readonly logger = new Logger(SandboxPreviewDeployService.name);

  private readonly inflight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly crypto: SecretCryptoService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly sessions: SandboxSessionsService
  ) {}

  onModuleInit(): void {
    this.sessions.setPreviewHooks({
      teardown: (sandbox, row, reason) => this.teardownForSession(sandbox, row, reason)
    });
  }

  async projectServices(): Promise<PreviewProjectServices> {
    const [{ DeploymentsService }, { EnvironmentsService }, { IngressService }] = await Promise.all(
      [
        import('../../projects/deployments.service.js'),
        import('../../projects/environments.service.js'),
        import('../../projects/ingress.service.js')
      ]
    );
    return {
      deployments: this.moduleRef.get(DeploymentsService, { strict: false }),
      environments: this.moduleRef.get(EnvironmentsService, { strict: false }),
      ingress: this.moduleRef.get(IngressService, { strict: false })
    };
  }

  private async sessionRow(sandboxId: string, sessionId: string): Promise<SandboxConversation> {
    if (!isUuid(sessionId)) throw new BadRequestException('Invalid session id');
    const row = await this.prisma.sandboxConversation.findFirst({
      where: { id: sessionId, sandboxId, slug: { not: null } }
    });
    if (!row) throw new NotFoundException('Session not found');
    return row;
  }

  private async targetProject(sandbox: PreviewSandbox, projectId: unknown, actor: PreviewActor) {
    if (!isUuid(projectId)) throw new BadRequestException('projectId must be a UUID');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, slug: true, organizationId: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    if (sandbox.organizationId && project.organizationId !== sandbox.organizationId) {
      throw new BadRequestException(
        "Previews can only deploy into a project in this sandbox's organization"
      );
    }
    await this.authz.requireProjectEdit(project.id, actor.id, 'deploy previews');
    return project;
  }

  async deploy(
    sandbox: PreviewSandbox,
    sessionId: string,
    actor: PreviewActor,
    body: { projectId?: unknown; deploymentId?: unknown }
  ): Promise<PreviewDeployResult> {
    if (this.inflight.has(sessionId)) {
      throw new ConflictException('A preview deploy is already running for this session');
    }
    this.inflight.add(sessionId);
    try {
      return await this.deployLocked(sandbox, sessionId, actor, body ?? {});
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  private async deployLocked(
    sandbox: PreviewSandbox,
    sessionId: string,
    actor: PreviewActor,
    body: { projectId?: unknown; deploymentId?: unknown }
  ): Promise<PreviewDeployResult> {
    if (body.deploymentId !== undefined && body.deploymentId !== null) {
      if (!isUuid(body.deploymentId)) {
        throw new BadRequestException('deploymentId must be a UUID');
      }
    }
    const row = await this.sessionRow(sandbox.id, sessionId);
    if (row.archivedAt) throw new BadRequestException('This session is archived');
    if (!row.repo || !isWorktreePath(row.worktreePath)) {
      throw new BadRequestException('This session has no worktree');
    }
    const project = await this.targetProject(sandbox, body.projectId, actor);
    const existing = row.previewDeploymentId
      ? await this.prisma.deployment.findUnique({
          where: { id: row.previewDeploymentId },
          select: { id: true, projectId: true, environmentId: true, githubBranch: true }
        })
      : null;
    if (existing && existing.projectId !== project.id) {
      throw new ConflictException(
        'This session already has a preview in another project; remove it first'
      );
    }
    if (sandbox.status !== 'running') throw new SandboxNotRunningError();

    const pushed = await this.workspace.gitPush(sandbox, { session: row.id }, actor.id);
    if (!pushed.ok) {
      const detail = pushed.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      throw new BadRequestException(
        `Could not push ${row.branch ?? 'the session branch'}${detail ? `: ${detail}` : ''}`
      );
    }
    const head = parsePushedHead(
      (
        await this.workspace.runIn(
          sandbox,
          row.worktreePath,
          WORKTREES_ROOT,
          'git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; git remote get-url origin'
        )
      ).stdout
    );
    if (!head.branch) throw new BadRequestException('The session worktree is not on a branch');
    if (!head.repo) throw new BadRequestException('The session repository has no GitHub origin');

    const services = await this.projectServices();
    const userData = actor.email ? { email: actor.email } : undefined;
    let deploymentId: string;
    let environmentId: string;
    let redeployed = false;
    let skippedEnv: string[] = [];

    if (existing?.environmentId) {
      deploymentId = existing.id;
      environmentId = existing.environmentId;
      await this.redeploy(services, existing, head.branch, actor, userData);
      redeployed = true;
    } else {
      const source = await this.sourceDeployment(project, head.repo, body.deploymentId as string);
      const env = await this.ensureEnvironment(services, project.id, row, actor.id);
      environmentId = env.id;
      const already = await this.prisma.deployment.findFirst({
        where: { environmentId: env.id, name: source.name },
        select: { id: true, projectId: true, environmentId: true, githubBranch: true }
      });
      if (already) {
        deploymentId = already.id;
        await this.redeploy(services, already, head.branch, actor, userData);
        redeployed = true;
      } else {
        const clone = await this.cloneRequest(source, env.id, head.branch);
        skippedEnv = clone.skipped;
        const created: any = await services.deployments.createDeploymentFromGitHub(
          project.id,
          clone.body,
          actor.clerkId,
          userData
        );
        if (!created?.id) throw new BadRequestException('The preview deployment was not created');
        deploymentId = created.id;
      }
    }

    await services.ingress
      .createAutoIngressForDeployment(deploymentId, actor.clerkId, userData)
      .catch((e: any) => this.logger.warn(`preview URL for ${deploymentId} failed: ${e?.message}`));
    const url = await this.urlFor(deploymentId);
    await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data: {
        previewDeploymentId: deploymentId,
        previewEnvironmentId: environmentId,
        previewUrl: url ? url.slice(0, 500) : null
      }
    });
    void this.audit.log({
      action: redeployed
        ? 'sandbox.session.preview.redeployed'
        : 'sandbox.session.preview.deployed',
      actorUserId: actor.id,
      actorEmail: actor.email ?? null,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId,
      targetType: 'sandbox',
      targetId: sandbox.id,
      targetLabel: sandbox.name,
      metadata: {
        sessionId: row.id,
        environmentId,
        branch: head.branch,
        commit: head.commit,
        skippedEnv: skippedEnv.join(',') || null
      }
    });
    const session = await this.sessions.notifyChanged(sandbox, row.id);
    return {
      session,
      deploymentId,
      environmentId,
      url,
      branch: head.branch,
      commit: head.commit,
      redeployed,
      skippedEnv
    };
  }

  private async redeploy(
    services: PreviewProjectServices,
    deployment: { id: string; githubBranch: string | null },
    branch: string,
    actor: PreviewActor,
    userData: { email: string } | undefined
  ): Promise<void> {
    if (deployment.githubBranch !== branch) {
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { githubBranch: branch }
      });
    }
    await services.deployments.rebuildDeployment(deployment.id, actor.clerkId, userData);
  }

  private async urlFor(deploymentId: string): Promise<string | null> {
    const ingresses: PreviewIngressRow[] = await this.prisma.ingress.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' },
      select: { host: true, path: true, tlsSecretName: true, entrypoints: true }
    });
    return previewUrlOf(ingresses);
  }

  async sourceDeployment(
    project: { id: string; name: string },
    repo: string,
    deploymentId: string | undefined
  ) {
    const rows = await this.prisma.deployment.findMany({
      where: deploymentId
        ? { id: deploymentId, projectId: project.id }
        : { projectId: project.id, githubRepo: { not: null } },
      include: SOURCE_INCLUDE,
      orderBy: { createdAt: 'asc' }
    });
    if (deploymentId) {
      const picked = rows[0];
      if (!picked) throw new NotFoundException('Deployment not found in this project');
      if (normalizeGithubRepo(picked.githubRepo) !== repo) {
        throw new BadRequestException(
          `That deployment builds ${picked.githubRepo ?? 'no GitHub repository'}, not ${repo}`
        );
      }
      return picked;
    }
    const candidates = rows.filter(
      (d) =>
        normalizeGithubRepo(d.githubRepo) === repo &&
        !isPreviewEnvSlug(d.environment?.slug) &&
        !d.composeStackId &&
        !d.templateInstanceId
    );
    const rank = (d: (typeof candidates)[number]) =>
      d.environment?.isDefault ? 0 : d.environment?.isProduction ? 1 : 2;
    candidates.sort((a, b) => rank(a) - rank(b));
    if (!candidates[0]) {
      throw new BadRequestException(
        `No deployment in ${project.name} builds ${repo}. Pass deploymentId to choose one to copy.`
      );
    }
    return candidates[0];
  }

  private async cloneRequest(
    source: Awaited<ReturnType<SandboxPreviewDeployService['sourceDeployment']>>,
    environmentId: string,
    branch: string
  ) {
    const shared = source.environmentId
      ? await this.prisma.environmentSharedVar.findMany({
          where: { environmentId: source.environmentId },
          select: { key: true, value: true, secret: true }
        })
      : [];
    const { env, skipped } = cloneEnv(
      source.envVars.map((v) => this.crypto.maybeDecrypt(v)),
      shared.map((v) => this.crypto.maybeDecrypt(v))
    );
    const service = source.services[0];
    const ports = (service?.ports ?? []).map((p) => ({
      name: p.name ?? undefined,
      containerPort: p.targetPort,
      servicePort: p.port,
      protocol: p.protocol ?? 'TCP'
    }));
    return {
      skipped,
      body: {
        name: source.name,
        environmentId,
        githubRepo: source.githubRepo ?? undefined,
        gitConnectionId: source.gitConnectionId,
        externalRepoId: source.externalRepoId,
        branch,
        buildType: source.buildType,
        dockerfilePath: source.dockerfilePath ?? undefined,
        target: source.dockerfileTarget ?? undefined,
        buildFromRoot: source.buildFromRoot,
        rootDirectory: source.rootDirectory,
        framework: source.framework,
        installCommand: source.installCommand,
        buildCommand: source.buildCommand,
        startCommand: source.startCommand,
        outputDirectory: source.outputDirectory,
        ...(ports.length > 0 ? { ports } : {}),
        replicas: 1,
        env,
        volumes: source.volumes
          .filter((v) => v.type !== 'hostPath')
          .map((v) => ({
            name: v.name,
            type: v.type as 'pvc' | 'emptyDir',
            mountPath: v.mountPath,
            pvcName: v.pvcName ?? undefined,
            storageSize: v.storageSize ?? undefined,
            readOnly: v.readOnly
          })),
        cpuRequestMilli: source.cpuRequestMilli,
        memoryRequestBytes:
          source.memoryRequestBytes != null ? Number(source.memoryRequestBytes) : null
      }
    };
  }

  private async ensureEnvironment(
    services: PreviewProjectServices,
    projectId: string,
    row: SandboxConversation,
    userId: string
  ): Promise<{ id: string }> {
    const slug = previewEnvSlug(row.slug ?? row.id);
    const byId = row.previewEnvironmentId
      ? await this.prisma.environment.findUnique({ where: { id: row.previewEnvironmentId } })
      : null;
    let env =
      byId && byId.projectId === projectId
        ? byId
        : await this.prisma.environment.findUnique({
            where: { projectId_slug: { projectId, slug } }
          });
    if (env) {
      if (!isPreviewEnvSlug(env.slug) || env.isDefault || env.isProduction) {
        throw new ConflictException(`Environment ${env.slug} is not a preview environment`);
      }
      const claimed = await this.prisma.sandboxConversation.findFirst({
        where: { previewEnvironmentId: env.id, id: { not: row.id } },
        select: { id: true }
      });
      if (claimed) {
        throw new ConflictException(`Environment ${env.slug} belongs to another session`);
      }
    } else {
      try {
        env = await services.environments.createEnvironment(
          projectId,
          { name: slug, slug },
          userId
        );
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        env = await this.prisma.environment.findUnique({
          where: { projectId_slug: { projectId, slug } }
        });
        if (!env) throw e;
      }
    }
    await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data: { previewEnvironmentId: env.id }
    });
    return { id: env.id };
  }

  async remove(
    sandbox: PreviewSandbox,
    sessionId: string,
    actor: PreviewActor
  ): Promise<{ session: SessionDto; removed: boolean }> {
    const row = await this.sessionRow(sandbox.id, sessionId);
    if (!row.previewDeploymentId && !row.previewEnvironmentId) {
      return { session: await this.sessions.get(sandbox, row.id), removed: false };
    }
    const target = await this.previewTarget(row);
    if (target) await this.authz.requireProjectEdit(target.projectId, actor.id, 'remove previews');
    await this.teardown(
      sandbox,
      row,
      { userId: actor.id, email: actor.email ?? undefined },
      'removed'
    );
    return { session: await this.sessions.notifyChanged(sandbox, row.id), removed: true };
  }

  async teardownForSession(
    sandbox: WorkspaceSandbox,
    row: SandboxConversation,
    reason: 'archived' | 'deleted'
  ): Promise<void> {
    await this.teardown(sandbox as PreviewSandbox, row, null, reason);
    if (reason === 'archived') {
      await this.sessions.notifyChanged(sandbox, row.id).catch(() => null);
    }
  }

  private async previewTarget(row: SandboxConversation) {
    const env = row.previewEnvironmentId
      ? await this.prisma.environment.findUnique({
          where: { id: row.previewEnvironmentId },
          include: { project: { select: { organizationId: true } } }
        })
      : null;
    if (env) return { projectId: env.projectId, env };
    const deployment = row.previewDeploymentId
      ? await this.prisma.deployment.findUnique({
          where: { id: row.previewDeploymentId },
          select: {
            projectId: true,
            environment: { include: { project: { select: { organizationId: true } } } }
          }
        })
      : null;
    if (!deployment) return null;
    return { projectId: deployment.projectId, env: deployment.environment };
  }

  async teardown(
    sandbox: PreviewSandbox,
    row: SandboxConversation,
    actor: { userId: string; email?: string } | null,
    reason: 'removed' | 'archived' | 'deleted'
  ): Promise<boolean> {
    const target = await this.previewTarget(row);
    const env = target?.env ?? null;
    let deleted = false;
    if (env && isPreviewEnvSlug(env.slug) && !env.isDefault && !env.isProduction) {
      const services = await this.projectServices();
      if (actor) {
        await services.environments.deleteEnvironment(env.id, actor, env.name);
      } else {
        await services.environments.deleteEnvironmentFromCluster(env.id, {
          reason: `sandbox.session.${reason}`,
          source: 'greenhouse',
          namespace: env.namespace
        });
      }
      deleted = true;
    } else if (env) {
      this.logger.warn(`not deleting ${env.slug} for session ${row.id}: not a preview environment`);
    }
    await this.prisma.sandboxConversation.updateMany({
      where: { id: row.id },
      data: { previewDeploymentId: null, previewEnvironmentId: null, previewUrl: null }
    });
    void this.audit.log({
      action: 'sandbox.session.preview.removed',
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      organizationId: env?.project?.organizationId ?? sandbox.organizationId ?? null,
      projectId: target?.projectId ?? null,
      targetType: 'sandbox',
      targetId: sandbox.id,
      targetLabel: sandbox.name ?? null,
      metadata: {
        sessionId: row.id,
        reason,
        environmentId: env?.id ?? null,
        deploymentId: row.previewDeploymentId,
        environmentDeleted: deleted
      }
    });
    return deleted;
  }
}
