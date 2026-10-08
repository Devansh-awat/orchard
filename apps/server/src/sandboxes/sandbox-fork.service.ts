import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { refOf } from './runners/sandbox-runner';
import { SandboxesService, withRole, type SandboxDto } from './sandboxes.service';
import type { SandboxAccess } from './sandbox-access.service';

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME = 63;

const WITH_IDENTITY = {
  sshIdentity: { select: { id: true, name: true } },
  user: { select: { id: true, username: true, email: true } }
} as const;

export function forkName(sourceName: string, suffix: string): string {
  const tail = `-fork${suffix}`;
  const base = sourceName.slice(0, MAX_NAME - tail.length).replace(/-+$/, '');
  return `${base || 'sandbox'}${tail}`;
}

export function forkedSessionRows(
  sessions: Array<{
    title: string;
    repo: string | null;
    slug: string | null;
    branch: string | null;
    baseBranch: string | null;
    baseCommit: string | null;
    worktreePath: string | null;
    agent: string;
    createdById: string | null;
  }>,
  sandboxId: string
): Prisma.SandboxConversationCreateManyInput[] {
  return sessions
    .filter((s) => s.slug)
    .map((s) => ({
      sandboxId,
      title: s.title,
      repo: s.repo,
      slug: s.slug,
      branch: s.branch,
      baseBranch: s.baseBranch,
      baseCommit: s.baseCommit,
      worktreePath: s.worktreePath,
      agent: s.agent,
      createdById: s.createdById
    }));
}

@Injectable()
export class SandboxForkService {
  private readonly logger = new Logger(SandboxForkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly sandboxes: SandboxesService,
    private readonly audit: AuditService
  ) {}

  private async pickName(userId: string, sourceName: string, requested: unknown): Promise<string> {
    if (requested !== undefined && requested !== null && requested !== '') {
      if (typeof requested !== 'string') throw new BadRequestException('name must be a string');
      const name = requested.trim();
      if (name.length > MAX_NAME || !NAME_RE.test(name)) {
        throw new BadRequestException(
          'Sandbox name must be a lowercase DNS label (a-z, 0-9, hyphens, max 63 chars)'
        );
      }
      return name;
    }
    for (const suffix of ['', ...Array.from({ length: 4 }, () => `-${randomUUID().slice(0, 4)}`)]) {
      const name = forkName(sourceName, suffix);
      const taken = await this.prisma.sandbox.findUnique({
        where: { userId_name: { userId, name } },
        select: { id: true }
      });
      if (!taken) return name;
    }
    throw new ConflictException('Could not find a free name for the fork; pass one explicitly');
  }

  async fork(
    access: SandboxAccess,
    actorEmail: string | null,
    body: { name?: unknown }
  ): Promise<SandboxDto> {
    const source = access.sandbox;
    const userId = access.userId;
    if (source.userId !== userId) {
      throw new ForbiddenException(
        "Only the machine's owner can fork it: the copy carries their home directory and credentials"
      );
    }
    if (source.desiredState === 'deleted' || source.status === 'deleting') {
      throw new BadRequestException('Sandbox is being deleted');
    }
    await this.sandboxes.requireCanCreateIn(source.organizationId, userId);
    const runner = this.registry.for(source);
    if (!this.registry.enabled(runner.id)) {
      throw new ConflictException(`${runner.label} sandboxes are turned off on this server`);
    }
    const configError = runner.configError();
    if (configError) throw new ConflictException(configError);
    if (!runner.capabilities.fork || !runner.requestFork) {
      throw new ConflictException(
        `Forking is not available for ${runner.label} sandboxes on this server`
      );
    }
    const unsupported = runner.forkSupport ? await runner.forkSupport(refOf(source)) : null;
    if (unsupported) throw new ConflictException(unsupported);

    const [count, cap] = await Promise.all([
      this.prisma.sandbox.count({ where: { userId, desiredState: { not: 'deleted' } } }),
      this.sandboxes.sandboxCap(userId)
    ]);
    if (cap !== null && count >= cap) {
      throw new ForbiddenException(
        `Sandbox limit reached (${count} of ${cap}). Ask an admin to raise your limit.`
      );
    }
    const name = await this.pickName(userId, source.name, body?.name);
    const id = randomUUID();
    const sessions = await this.prisma.sandboxConversation.findMany({
      where: { sandboxId: source.id, slug: { not: null }, archivedAt: null },
      select: {
        title: true,
        repo: true,
        slug: true,
        branch: true,
        baseBranch: true,
        baseCommit: true,
        worktreePath: true,
        agent: true,
        createdById: true
      }
    });
    const row = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.sandbox.create({
          data: {
            id,
            userId,
            organizationId: source.organizationId,
            name,
            runner: source.runner,
            desiredState: 'running',
            status: 'creating',
            startedAt: new Date(),
            podName: `sbx-${id}`,
            namespace: runner.namespace ?? null,
            runnerState: { forkFrom: { sandboxId: source.id, podName: source.podName } },
            image: source.image,
            repoUrl: source.repoUrl,
            sshIdentityId: source.sshIdentityId,
            setupScript: source.setupScript,
            cpuLimit: source.cpuLimit,
            memoryLimit: source.memoryLimit,
            diskSize: source.diskSize
          },
          include: WITH_IDENTITY
        });
        const rows = forkedSessionRows(sessions, id);
        if (rows.length) await tx.sandboxConversation.createMany({ data: rows });
        return created;
      })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${name}"`);
        }
        throw e;
      });

    this.audit
      .log({
        action: 'sandbox.fork',
        actorUserId: userId,
        actorEmail,
        organizationId: source.organizationId,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: name,
        metadata: {
          sourceSandboxId: source.id,
          sourceName: source.name,
          runner: source.runner,
          sessions: sessions.length
        }
      })
      .catch(() => {});

    try {
      await runner.requestFork(refOf(source), refOf(row), userId);
    } catch (e: any) {
      this.logger.error(`sandbox fork ${row.id} from ${source.id} failed: ${e?.message}`);
      const failed = await this.prisma.sandbox.update({
        where: { id: row.id },
        data: {
          status: 'error',
          statusMessage: `Failed to fork sandbox: ${e?.message || 'unknown error'}`
        },
        include: WITH_IDENTITY
      });
      return withRole(await this.sandboxes.dto(failed), 'owner');
    }
    return withRole(await this.sandboxes.dto(row), 'owner');
  }
}
