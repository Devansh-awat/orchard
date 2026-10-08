import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../auth/authorization.service';
import { AuditService } from '../../audit/audit.service';
import { onEnvironmentEnvChanged, type EnvironmentEnvChange } from '../../env/env-change-signal';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, refOf } from '../runners/sandbox-runner';
import { isUuid } from '../sandbox-session-commands';
import { isEnvFileSlug } from './sandbox-env-files';

export interface LinkSandbox {
  id: string;
  name: string;
  userId: string;
  organizationId: string | null;
}

export interface LinkActor {
  id: string;
  email?: string | null;
}

export interface SandboxProjectLinkDto {
  id: string;
  projectId: string;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; slug: string };
  envFile: string;
  createdBy: { id: string; name: string; avatarUrl: string | null } | null;
  createdAt: Date;
}

const LINK_SELECT = {
  id: true,
  projectId: true,
  createdAt: true,
  project: { select: { id: true, name: true, slug: true } },
  environment: { select: { id: true, name: true, slug: true } },
  createdBy: {
    select: { id: true, username: true, firstName: true, lastName: true, imageUrl: true }
  }
} as const;

type LinkRow = {
  id: string;
  projectId: string;
  createdAt: Date;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; slug: string };
  createdBy: {
    id: string;
    username: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string | null;
  } | null;
};

export function envFilePathFor(projectSlug: string): string {
  return `~/.config/orchard/env/${projectSlug}.env`;
}

export function toLinkDto(row: LinkRow): SandboxProjectLinkDto {
  const user = row.createdBy;
  const name = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username
    : null;
  return {
    id: row.id,
    projectId: row.projectId,
    project: row.project,
    environment: row.environment,
    envFile: envFilePathFor(row.project.slug),
    createdBy: user ? { id: user.id, name: name!, avatarUrl: user.imageUrl } : null,
    createdAt: row.createdAt
  };
}

@Injectable()
export class SandboxProjectLinksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxProjectLinksService.name);

  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly registry: SandboxRunnerRegistry
  ) {}

  onModuleInit(): void {
    this.unsubscribe = onEnvironmentEnvChanged((change) => {
      void this.resyncFor(change).catch((e) =>
        this.logger.warn(`linked sandbox resync failed: ${e?.message}`)
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async list(sandbox: LinkSandbox): Promise<{ links: SandboxProjectLinkDto[] }> {
    const rows = await this.prisma.sandboxProjectLink.findMany({
      where: { sandboxId: sandbox.id },
      orderBy: { createdAt: 'asc' },
      select: LINK_SELECT
    });
    return { links: rows.map((r) => toLinkDto(r as LinkRow)) };
  }

  async attach(
    sandbox: LinkSandbox,
    actor: LinkActor,
    body: { projectId?: unknown; environmentId?: unknown }
  ): Promise<SandboxProjectLinkDto> {
    if (!isUuid(body?.projectId)) throw new BadRequestException('projectId must be a UUID');
    if (body.environmentId !== undefined && body.environmentId !== null) {
      if (!isUuid(body.environmentId)) {
        throw new BadRequestException('environmentId must be a UUID');
      }
    }
    const project = await this.prisma.project.findUnique({
      where: { id: body.projectId },
      select: { id: true, name: true, slug: true, organizationId: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    if (sandbox.organizationId && project.organizationId !== sandbox.organizationId) {
      throw new BadRequestException(
        "Only projects in this sandbox's organization can be attached to it"
      );
    }
    await this.authz.requireProjectEdit(
      project.id,
      actor.id,
      "read this project's environment variables"
    );
    if (!isEnvFileSlug(project.slug)) {
      throw new BadRequestException('This project slug cannot be used as an env file name');
    }
    const environment = await this.environmentFor(project.id, body.environmentId as string);
    const row = await this.prisma.sandboxProjectLink.upsert({
      where: { sandboxId_projectId: { sandboxId: sandbox.id, projectId: project.id } },
      create: {
        sandboxId: sandbox.id,
        projectId: project.id,
        environmentId: environment.id,
        createdById: actor.id
      },
      update: { environmentId: environment.id, createdById: actor.id },
      select: LINK_SELECT
    });
    void this.audit.log({
      action: 'sandbox.project.attached',
      actorUserId: actor.id,
      actorEmail: actor.email ?? null,
      organizationId: project.organizationId,
      projectId: project.id,
      targetType: 'sandbox',
      targetId: sandbox.id,
      targetLabel: sandbox.name,
      metadata: {
        environmentId: environment.id,
        environment: environment.name,
        envFile: envFilePathFor(project.slug)
      }
    });
    await this.resync([sandbox.id], actor.id);
    return toLinkDto(row as LinkRow);
  }

  async detach(
    sandbox: LinkSandbox,
    actor: LinkActor,
    projectId: string
  ): Promise<{ success: boolean }> {
    if (!isUuid(projectId)) throw new BadRequestException('projectId must be a UUID');
    const link = await this.prisma.sandboxProjectLink.findUnique({
      where: { sandboxId_projectId: { sandboxId: sandbox.id, projectId } },
      select: {
        id: true,
        environmentId: true,
        project: { select: { id: true, slug: true, organizationId: true } }
      }
    });
    if (!link) throw new NotFoundException('That project is not attached to this sandbox');
    await this.prisma.sandboxProjectLink.deleteMany({ where: { id: link.id } });
    void this.audit.log({
      action: 'sandbox.project.detached',
      actorUserId: actor.id,
      actorEmail: actor.email ?? null,
      organizationId: link.project.organizationId,
      projectId: link.project.id,
      targetType: 'sandbox',
      targetId: sandbox.id,
      targetLabel: sandbox.name,
      metadata: { environmentId: link.environmentId, envFile: envFilePathFor(link.project.slug) }
    });
    await this.resync([sandbox.id], actor.id);
    return { success: true };
  }

  private async environmentFor(projectId: string, environmentId: string | undefined) {
    const env = environmentId
      ? await this.prisma.environment.findUnique({
          where: { id: environmentId },
          select: { id: true, name: true, projectId: true }
        })
      : await this.prisma.environment.findFirst({
          where: { projectId, isDefault: true },
          orderBy: { isProduction: 'desc' },
          select: { id: true, name: true, projectId: true }
        });
    if (!env || env.projectId !== projectId) {
      throw new BadRequestException(
        environmentId
          ? 'Environment does not belong to this project'
          : 'This project has no default environment'
      );
    }
    return env;
  }

  async resyncFor(change: EnvironmentEnvChange): Promise<void> {
    if (!change.environmentId && !change.projectId) return;
    const links = await this.prisma.sandboxProjectLink.findMany({
      where: change.environmentId
        ? { environmentId: change.environmentId }
        : { projectId: change.projectId! },
      select: { sandboxId: true }
    });
    await this.resync([...new Set(links.map((l) => l.sandboxId))], null);
  }

  async resync(sandboxIds: string[], requestedById: string | null): Promise<void> {
    if (sandboxIds.length === 0) return;
    const rows = await this.prisma.sandbox.findMany({
      where: { id: { in: sandboxIds }, desiredState: { not: 'deleted' } },
      select: SANDBOX_REF_SELECT
    });
    for (const row of rows) {
      try {
        await this.registry.for(row).requestSecretSync(refOf(row), requestedById);
      } catch (e: any) {
        this.logger.warn(`could not queue a secret sync for ${row.id}: ${e?.message}`);
      }
    }
  }
}
