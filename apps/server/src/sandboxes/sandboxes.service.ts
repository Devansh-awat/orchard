import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Sandbox, SandboxDesiredState, SandboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { SandboxRunnerRegistry, SandboxRunnerDescription } from './runners/sandbox-runner.registry';
import { SandboxRunnerId, refOf } from './runners/sandbox-runner';
import { SandboxAccessService, SandboxRole } from './sandbox-access.service';

const DEFAULT_SANDBOX_IMAGE = 'debian:bookworm';
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SETUP_SCRIPT_LENGTH = 65536;

export interface SandboxDto {
  id: string;
  name: string;
  status: SandboxStatus;
  statusMessage: string | null;
  runner: SandboxRunnerId;
  desiredState: SandboxDesiredState;
  applying: boolean;
  applyError: string | null;
  diskObserved: string | null;
  repoUrl: string | null;
  sshIdentity: { id: string; name: string } | null;
  setupScript: string | null;
  image: string;
  organizationId: string | null;
  owner: { id: string; username: string | null; email: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date | null;
  myRole?: SandboxRole;
}

export interface SandboxDtoExtras {
  applying: boolean;
  applyError: string | null;
  diskObserved: string | null;
}

const NO_EXTRAS: SandboxDtoExtras = { applying: false, applyError: null, diskObserved: null };

type SandboxWithIdentity = Sandbox & {
  sshIdentity: { id: string; name: string } | null;
  user?: { id: string; username: string | null; email: string | null } | null;
};

const WITH_IDENTITY = {
  sshIdentity: { select: { id: true, name: true } },
  user: { select: { id: true, username: true, email: true } }
} as const;

export function defaultMaxSandboxes(): number {
  const parsed = Number(process.env.SANDBOX_MAX_PER_USER);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

export function toSandboxDto(
  row: SandboxWithIdentity,
  extras: SandboxDtoExtras = NO_EXTRAS
): SandboxDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusMessage: row.statusMessage,
    runner: row.runner,
    desiredState: row.desiredState,
    applying: extras.applying,
    applyError: extras.applyError,
    diskObserved: extras.diskObserved,
    repoUrl: row.repoUrl,
    sshIdentity: row.sshIdentity ? { id: row.sshIdentity.id, name: row.sshIdentity.name } : null,
    setupScript: row.setupScript,
    image: row.image,
    organizationId: row.organizationId,
    owner: row.user
      ? { id: row.user.id, username: row.user.username, email: row.user.email }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActiveAt: row.lastActiveAt
  };
}

@Injectable()
export class SandboxesService {
  private readonly logger = new Logger(SandboxesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly crypto: SecretCryptoService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly access: SandboxAccessService
  ) {}

  async dtos(rows: SandboxWithIdentity[]): Promise<SandboxDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const items = await this.prisma.k8sApplyItem.findMany({
      where: { sandboxId: { in: ids }, status: { in: ['pending', 'applying', 'failed'] } },
      select: { sandboxId: true, status: true, lastError: true },
      orderBy: { updatedAt: 'desc' }
    });
    const extras = new Map<string, SandboxDtoExtras>(ids.map((id) => [id, { ...NO_EXTRAS }]));
    for (const item of items) {
      const entry = item.sandboxId ? extras.get(item.sandboxId) : undefined;
      if (!entry) continue;
      if (item.status === 'failed') {
        if (entry.applyError === null) entry.applyError = item.lastError || 'apply failed';
      } else {
        entry.applying = true;
      }
    }
    const byRunner = new Map<SandboxRunnerId, SandboxWithIdentity[]>();
    for (const row of rows) {
      const list = byRunner.get(row.runner) ?? [];
      list.push(row);
      byRunner.set(row.runner, list);
    }
    for (const [id, list] of byRunner) {
      const runner = this.registry.get(id);
      if (!runner?.observeDisks) continue;
      const disks = await runner.observeDisks(list.map(refOf)).catch(() => new Map());
      for (const [sandboxId, size] of disks) {
        const entry = extras.get(sandboxId);
        if (entry) entry.diskObserved = size;
      }
    }
    return rows.map((row) => toSandboxDto(row, extras.get(row.id)));
  }

  async dto(row: SandboxWithIdentity): Promise<SandboxDto> {
    const [dto] = await this.dtos([row]);
    return dto;
  }

  private async reload(id: string): Promise<SandboxWithIdentity> {
    return this.prisma.sandbox.findUniqueOrThrow({ where: { id }, include: WITH_IDENTITY });
  }

  /** The user's sandbox cap, or null when they are not capped at all. */
  private async sandboxCap(userId: string): Promise<number | null> {
    if (await this.authz.isSuperAdmin(userId)) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { maxSandboxes: true }
    });
    return user?.maxSandboxes ?? defaultMaxSandboxes();
  }

  async list(
    userId: string,
    organizationId?: string
  ): Promise<{
    sandboxes: SandboxDto[];
    maxSandboxes: number | null;
    runners: SandboxRunnerDescription[];
    defaultRunner: SandboxRunnerId | null;
  }> {
    let orgAdmin = false;
    if (organizationId) {
      const access = await this.authz.requireOrgMember(organizationId, userId);
      orgAdmin = access.isAdmin;
    }
    const shared = await this.access.sharedSandboxIds(userId);
    const sharedIds = [...shared.keys()];
    const own: Record<string, unknown> = organizationId
      ? orgAdmin
        ? { organizationId }
        : { organizationId, userId }
      : { userId };
    const sharedWhere: Record<string, unknown> = organizationId
      ? { id: { in: sharedIds }, organizationId }
      : { id: { in: sharedIds } };
    const [rows, maxSandboxes] = await Promise.all([
      this.prisma.sandbox.findMany({
        where: sharedIds.length ? { OR: [own, sharedWhere] } : own,
        orderBy: { createdAt: 'asc' },
        include: WITH_IDENTITY
      }),
      this.sandboxCap(userId)
    ]);
    const roleOf = (row: SandboxWithIdentity): SandboxRole => {
      if (row.userId === userId) return 'owner';
      const member = shared.get(row.id);
      if (member === 'collaborator') return member;
      if (orgAdmin) return 'admin';
      return member ?? 'viewer';
    };
    const dtos = await this.dtos(rows);
    const { runners, defaultRunner } = this.registry.describe();
    return {
      sandboxes: dtos.map((dto, i) => ({ ...dto, myRole: roleOf(rows[i]) })),
      maxSandboxes,
      runners,
      defaultRunner
    };
  }

  async getOwned(id: string, userId: string): Promise<SandboxWithIdentity> {
    const row = await this.prisma.sandbox.findUnique({ where: { id }, include: WITH_IDENTITY });
    if (!row) throw new NotFoundException('Sandbox not found');
    if (row.userId === userId) return row;
    if (await this.authz.isSuperAdmin(userId)) return row;
    if (row.organizationId) {
      const access = await this.authz
        .requireOrgMember(row.organizationId, userId)
        .catch(() => null);
      if (access?.isAdmin) return row;
    }
    throw new NotFoundException('Sandbox not found');
  }

  // Org admins can see and stop a member's sandbox, but never reach inside it:
  // the VM holds that member's Claude and GitHub credentials, so chat, shell,
  // files and git stay owner-only (platform superadmins excepted).
  async getOwnedStrict(id: string, userId: string): Promise<SandboxWithIdentity> {
    const row = await this.getOwned(id, userId);
    if (row.userId !== userId && !(await this.authz.isSuperAdmin(userId))) {
      throw new ForbiddenException('Only the sandbox owner can use this sandbox');
    }
    return row;
  }

  private validateName(name: string): void {
    if (name.length > 63 || !NAME_RE.test(name)) {
      throw new BadRequestException(
        'Sandbox name must be a lowercase DNS label (a-z, 0-9, hyphens, max 63 chars)'
      );
    }
  }

  private async resolveOrganization(
    userId: string,
    organizationId: string | undefined
  ): Promise<string> {
    if (organizationId) {
      await this.authz.requireOrgCanCreateProjects(organizationId, userId);
      return organizationId;
    }
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      orderBy: { addedAt: 'asc' },
      select: { organizationId: true, role: true }
    });
    const eligible = memberships.filter((m) => m.role !== 'guest');
    if (eligible.length === 0) {
      throw new ForbiddenException(
        memberships.length
          ? 'Guests cannot create sandboxes in this organization'
          : 'You must belong to an organization to create a sandbox'
      );
    }
    if (eligible.length > 1) {
      throw new BadRequestException(
        'You belong to multiple organizations; pass organizationId to pick one'
      );
    }
    await this.authz.requireOrgCanCreateProjects(eligible[0].organizationId, userId);
    return eligible[0].organizationId;
  }

  private async resolveIdentity(
    userId: string,
    sshIdentityId: string | undefined
  ): Promise<{ id: string; publicKey: string }> {
    if (sshIdentityId) {
      const identity = await this.prisma.sshIdentity.findUnique({ where: { id: sshIdentityId } });
      if (!identity || identity.userId !== userId) {
        throw new BadRequestException('SSH identity not found');
      }
      return { id: identity.id, publicKey: identity.publicKey };
    }
    const identities = await this.prisma.sshIdentity.findMany({ where: { userId }, take: 2 });
    if (identities.length === 1) {
      return { id: identities[0].id, publicKey: identities[0].publicKey };
    }
    throw new BadRequestException(
      identities.length === 0
        ? 'You have no SSH identities yet; add one in user settings first'
        : 'You have multiple SSH identities; pass sshIdentityId to pick one'
    );
  }

  private validateSetupScript(script: string | null | undefined): string | null {
    if (script === undefined || script === null || script === '') return null;
    if (script.length > MAX_SETUP_SCRIPT_LENGTH) {
      throw new BadRequestException(
        `Setup script must be at most ${MAX_SETUP_SCRIPT_LENGTH} characters`
      );
    }
    return script;
  }

  async create(
    userId: string,
    actorEmail: string | null,
    body: {
      name?: string;
      repoUrl?: string;
      sshIdentityId?: string;
      setupScript?: string | null;
      organizationId?: string;
      runner?: string;
    }
  ): Promise<SandboxDto> {
    const organizationId = await this.resolveOrganization(userId, body.organizationId);
    const setupScript = this.validateSetupScript(body.setupScript);
    const identity = await this.resolveIdentity(userId, body.sshIdentityId);
    const runner = this.registry.resolveForCreate(body.runner);
    const [count, cap] = await Promise.all([
      this.prisma.sandbox.count({ where: { userId, desiredState: { not: 'deleted' } } }),
      this.sandboxCap(userId)
    ]);
    if (cap !== null && count >= cap) {
      throw new ForbiddenException(
        `Sandbox limit reached (${count} of ${cap}). Ask an admin to raise your limit.`
      );
    }
    if (body.repoUrl !== undefined && body.repoUrl !== null && body.repoUrl !== '') {
      let parsed: URL;
      try {
        parsed = new URL(body.repoUrl);
      } catch {
        throw new BadRequestException('repoUrl must be a valid URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new BadRequestException('repoUrl must be an https URL');
      }
    }
    let name = body.name?.trim() || '';
    if (name) {
      this.validateName(name);
    } else {
      name = 'sandbox';
      const existing = await this.prisma.sandbox.findUnique({
        where: { userId_name: { userId, name } },
        select: { id: true }
      });
      if (existing) name = `sandbox-${Math.random().toString(36).slice(2, 6)}`;
    }
    const id = randomUUID();
    const row = await this.prisma.sandbox
      .create({
        data: {
          id,
          userId,
          organizationId,
          name,
          runner: runner.id,
          desiredState: 'running',
          status: 'creating',
          startedAt: new Date(),
          podName: `sbx-${id}`,
          namespace: runner.namespace ?? null,
          image: runner.defaultImage?.() ?? (process.env.SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE),
          repoUrl: body.repoUrl || null,
          sshIdentityId: identity.id,
          setupScript,
          cpuLimit: process.env.SANDBOX_CPU_LIMIT || '2',
          memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || '4Gi',
          diskSize: process.env.SANDBOX_DISK_SIZE || '10Gi'
        },
        include: WITH_IDENTITY
      })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${name}"`);
        }
        throw e;
      });

    this.audit
      .log({
        action: 'sandbox.create',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: name,
        metadata: { repoUrl: body.repoUrl || null, runner: runner.id }
      })
      .catch(() => {});

    try {
      await runner.requestProvision(refOf(row), userId);
    } catch (e: any) {
      this.logger.error(`sandbox ${row.id} create failed: ${e?.message}`);
      const failed = await this.prisma.sandbox.update({
        where: { id: row.id },
        data: {
          status: 'error',
          statusMessage: `Failed to create sandbox: ${e?.message || 'unknown error'}`
        },
        include: WITH_IDENTITY
      });
      return this.dto(failed);
    }
    return this.dto(row);
  }

  async update(
    id: string,
    userId: string,
    actorEmail: string | null,
    body: {
      name?: string;
      sshIdentityId?: string;
      setupScript?: string | null;
    }
  ): Promise<SandboxDto> {
    const row = await this.getOwnedStrict(id, userId);
    const data: { name?: string; sshIdentityId?: string; setupScript?: string | null } = {};
    if (body.setupScript !== undefined) {
      data.setupScript = this.validateSetupScript(body.setupScript);
    }
    if (body.name !== undefined) {
      const name = body.name.trim();
      this.validateName(name);
      data.name = name;
    }
    if (body.sshIdentityId !== undefined) {
      const identity = await this.resolveIdentity(row.userId, body.sshIdentityId);
      data.sshIdentityId = identity.id;
    }
    const updated = await this.prisma.sandbox
      .update({ where: { id: row.id }, data, include: WITH_IDENTITY })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${data.name}"`);
        }
        throw e;
      });
    if (data.sshIdentityId !== undefined || data.setupScript !== undefined) {
      await this.registry.for(updated).requestSecretSync(refOf(updated), userId);
      this.audit
        .log({
          action: 'sandbox.keys.update',
          actorUserId: userId,
          actorEmail,
          targetType: 'sandbox',
          targetId: updated.id,
          targetLabel: updated.name,
          metadata: {
            sshIdentity: updated.sshIdentity?.name ?? null,
            setupScript:
              data.setupScript === undefined ? 'unchanged' : data.setupScript ? 'set' : 'cleared'
          }
        })
        .catch(() => {});
    }
    return this.dto(updated);
  }

  async start(
    id: string,
    userId: string,
    actorEmail: string | null,
    authorized?: SandboxWithIdentity
  ): Promise<SandboxDto> {
    const row = authorized ?? (await this.getOwned(id, userId));
    if (row.status === 'deleting' || row.desiredState === 'deleted') {
      throw new BadRequestException('Sandbox is being deleted');
    }
    if (row.desiredState === 'running' && (row.status === 'running' || row.status === 'starting')) {
      return this.dto(row);
    }
    const runner = this.registry.for(row);
    const ref = refOf(row);
    const observed = await runner.observe(ref).catch(() => null);
    const trusted =
      observed && !observed.exists ? await runner.canTrustAbsence().catch(() => false) : false;
    const rebuilt = observed ? (observed.exists ? false : trusted ? true : null) : null;
    await this.prisma.sandbox.update({
      where: { id: row.id },
      data: {
        desiredState: 'running',
        status: observed?.status === 'running' ? 'running' : 'starting',
        statusMessage: null,
        lastActiveAt: new Date(),
        startedAt: new Date()
      }
    });
    await runner.requestStart(ref, userId);
    this.audit
      .log({
        action: 'sandbox.start',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
        metadata: { rebuilt }
      })
      .catch(() => {});
    return this.dto(await this.reload(row.id));
  }

  async stop(
    id: string,
    userId: string,
    actorEmail: string | null,
    authorized?: SandboxWithIdentity
  ): Promise<SandboxDto> {
    const row = authorized ?? (await this.getOwned(id, userId));
    if (row.status === 'deleting' || row.desiredState === 'deleted') {
      throw new BadRequestException('Sandbox is being deleted');
    }
    if (row.desiredState === 'stopped' && (row.status === 'stopped' || row.status === 'stopping')) {
      return this.dto(row);
    }
    const runner = this.registry.for(row);
    const ref = refOf(row);
    const observed = await runner.observe(ref).catch(() => null);
    const gone =
      observed && !observed.exists ? await runner.canTrustAbsence().catch(() => false) : false;
    const settled = gone || observed?.status === 'stopped';
    await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { desiredState: 'stopped', status: settled ? 'stopped' : 'stopping', startedAt: null }
    });
    await runner.requestStop(ref, userId);
    this.audit
      .log({
        action: 'sandbox.stop',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name
      })
      .catch(() => {});
    return this.dto(await this.reload(row.id));
  }

  async remove(
    id: string,
    userId: string,
    actorEmail: string | null,
    authorized?: SandboxWithIdentity
  ): Promise<void> {
    const row = authorized ?? (await this.getOwned(id, userId));
    const runner = this.registry.for(row);
    await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { desiredState: 'deleted', status: 'deleting' }
    });
    await runner.requestDestroy(refOf(row), userId);
    this.audit
      .log({
        action: 'sandbox.delete',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name
      })
      .catch(() => {});
  }

  async getCredentialPresence(userId: string): Promise<{ claude: boolean; openai: boolean }> {
    const credential = await this.prisma.sandboxCredential.findUnique({ where: { userId } });
    return { claude: !!credential?.claudeToken, openai: !!credential?.openaiToken };
  }

  async setCredentials(
    userId: string,
    actorEmail: string | null,
    body: { claudeToken?: string | null; openaiToken?: string | null }
  ): Promise<{ claude: boolean; openai: boolean }> {
    const wantsWrite =
      (typeof body.claudeToken === 'string' && body.claudeToken.length > 0) ||
      (typeof body.openaiToken === 'string' && body.openaiToken.length > 0);
    if (wantsWrite && !this.crypto.enabled) {
      throw new ServiceUnavailableException(
        'SECRETS_ENCRYPTION_KEY is not configured; refusing to store agent tokens in plaintext'
      );
    }
    const clean = (v: string) => v.replace(/\s+/g, '');
    const data: { claudeToken?: string | null; openaiToken?: string | null } = {};
    if (body.claudeToken !== undefined) {
      data.claudeToken = body.claudeToken ? this.crypto.encrypt(clean(body.claudeToken)) : null;
    }
    if (body.openaiToken !== undefined) {
      data.openaiToken = body.openaiToken ? this.crypto.encrypt(clean(body.openaiToken)) : null;
    }
    await this.prisma.sandboxCredential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data
    });
    const rows = await this.prisma.sandbox.findMany({
      where: { userId, desiredState: { not: 'deleted' } }
    });
    for (const row of rows) {
      try {
        await this.registry.for(row).requestSecretSync(refOf(row), userId);
      } catch (e: any) {
        this.logger.warn(`credential refresh failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
    this.audit
      .log({
        action: 'sandbox.credentials.update',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox_credentials',
        targetId: userId,
        metadata: {
          claude:
            body.claudeToken === undefined ? 'unchanged' : body.claudeToken ? 'set' : 'cleared',
          openai:
            body.openaiToken === undefined ? 'unchanged' : body.openaiToken ? 'set' : 'cleared'
        }
      })
      .catch(() => {});
    return this.getCredentialPresence(userId);
  }

  async touchActivity(id: string): Promise<void> {
    await this.prisma.sandbox
      .update({ where: { id }, data: { lastActiveAt: new Date() } })
      .catch(() => {});
  }
}
