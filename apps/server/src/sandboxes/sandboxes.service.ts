import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SignJWT } from 'jose';
import { Sandbox, SandboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { SandboxK8sService, SandboxSpecInput, k8sErrorMessage } from './sandbox-k8s.service';
import { sandboxStatusFromCr } from './sandbox-cr';

const DEFAULT_SANDBOX_IMAGE = 'debian:bookworm';
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SETUP_SCRIPT_LENGTH = 65536;

export interface SandboxDto {
  id: string;
  name: string;
  status: SandboxStatus;
  statusMessage: string | null;
  repoUrl: string | null;
  sshIdentity: { id: string; name: string } | null;
  setupScript: string | null;
  image: string;
  organizationId: string | null;
  owner: { id: string; username: string | null; email: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date | null;
}

type SandboxWithIdentity = Sandbox & {
  sshIdentity: { id: string; name: string } | null;
  user?: { id: string; username: string | null; email: string | null } | null;
};

function specOf(row: SandboxWithIdentity): SandboxSpecInput {
  return {
    id: row.id,
    podName: row.podName,
    userId: row.userId,
    repoUrl: row.repoUrl,
    image: row.image,
    cpuLimit: row.cpuLimit,
    memoryLimit: row.memoryLimit,
    diskSize: row.diskSize,
    setupScript: row.setupScript,
  };
}

export function defaultMaxSandboxes(): number {
  const parsed = Number(process.env.SANDBOX_MAX_PER_USER);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

export function toSandboxDto(row: SandboxWithIdentity): SandboxDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusMessage: row.statusMessage,
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
    lastActiveAt: row.lastActiveAt,
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
    private readonly k8s: SandboxK8sService,
  ) {}

  async list(
    userId: string,
    organizationId?: string,
  ): Promise<{ sandboxes: SandboxDto[]; maxSandboxes: number }> {
    let where: Record<string, unknown> = { userId };
    if (organizationId) {
      const access = await this.authz.requireOrgMember(organizationId, userId);
      where = access.isAdmin ? { organizationId } : { organizationId, userId };
    }
    const [rows, user] = await Promise.all([
      this.prisma.sandbox.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: {
          sshIdentity: { select: { id: true, name: true } },
          user: { select: { id: true, username: true, email: true } },
        },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { maxSandboxes: true } }),
    ]);
    return {
      sandboxes: rows.map(toSandboxDto),
      maxSandboxes: user?.maxSandboxes ?? defaultMaxSandboxes(),
    };
  }

  async getOwned(id: string, userId: string): Promise<SandboxWithIdentity> {
    const row = await this.prisma.sandbox.findUnique({
      where: { id },
      include: {
        sshIdentity: { select: { id: true, name: true } },
        user: { select: { id: true, username: true, email: true } },
      },
    });
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

  private async secretFor(row: SandboxWithIdentity) {
    const identity = row.sshIdentityId
      ? await this.prisma.sshIdentity.findUnique({ where: { id: row.sshIdentityId } })
      : null;
    return this.buildSecretInput(
      row.userId,
      identity ? [identity.publicKey] : [],
      row.setupScript,
    );
  }

  /**
   * Bring the cluster to "this sandbox is running", whatever it currently
   * holds, and report whether that meant building it again.
   *
   * Written as create-then-resume rather than look-then-decide on purpose. The
   * resource can go missing while the row survives — a cluster rebuild, a
   * namespace wipe, an over-eager sweep — and a start that assumes it is there
   * throws a raw 404 at whoever pressed the button. Asking first only moves the
   * race: the answer can be stale by the time it is acted on. Creating and
   * treating "already exists" as the other branch cannot be wrong either way.
   *
   * A rebuilt sandbox comes back empty. Its home volume went with the resource.
   */
  private async ensureRunning(row: SandboxWithIdentity): Promise<boolean> {
    const spec = specOf(row);
    const created = await this.k8s.createSandbox(spec, await this.secretFor(row));
    if (created) {
      this.logger.warn(`sandbox ${row.id} had no cluster resource; rebuilt it`);
      return true;
    }
    // The pod mounts bootstrap.sh, agent tokens and the opencode config from
    // its Secret, and keeps whatever pod template it was born with, so a
    // sandbox from before a platform change never sees either. createSandbox
    // has already rewritten the Secret; re-render the template to match. Best
    // effort: a stale template is not a reason to refuse to start the box.
    try {
      await this.k8s.refreshSpec(spec);
    } catch (e: any) {
      this.logger.warn(`spec refresh failed for sandbox ${row.id}: ${e?.message}`);
    }
    await this.k8s.resume(row.podName);
    return false;
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
        'Sandbox name must be a lowercase DNS label (a-z, 0-9, hyphens, max 63 chars)',
      );
    }
  }

  private async resolveOrganization(
    userId: string,
    organizationId: string | undefined,
  ): Promise<string> {
    if (organizationId) {
      await this.authz.requireOrgCanCreateProjects(organizationId, userId);
      return organizationId;
    }
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      orderBy: { addedAt: 'asc' },
      select: { organizationId: true, role: true },
    });
    const eligible = memberships.filter((m) => m.role !== 'guest');
    if (eligible.length === 0) {
      throw new ForbiddenException(
        memberships.length
          ? 'Guests cannot create sandboxes in this organization'
          : 'You must belong to an organization to create a sandbox',
      );
    }
    if (eligible.length > 1) {
      throw new BadRequestException(
        'You belong to multiple organizations; pass organizationId to pick one',
      );
    }
    await this.authz.requireOrgCanCreateProjects(eligible[0].organizationId, userId);
    return eligible[0].organizationId;
  }

  private async resolveIdentity(
    userId: string,
    sshIdentityId: string | undefined,
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
        : 'You have multiple SSH identities; pass sshIdentityId to pick one',
    );
  }

  private validateSetupScript(script: string | null | undefined): string | null {
    if (script === undefined || script === null || script === '') return null;
    if (script.length > MAX_SETUP_SCRIPT_LENGTH) {
      throw new BadRequestException(
        `Setup script must be at most ${MAX_SETUP_SCRIPT_LENGTH} characters`,
      );
    }
    return script;
  }

  private async mintMcpToken(userId: string): Promise<string | null> {
    if (!process.env.SANDBOX_MCP_URL || !process.env.JWT_SECRET) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true, externalAuthId: true },
    });
    if (!user) return null;
    let session = await this.prisma.session.findFirst({
      where: {
        userId,
        deviceName: 'sandbox-mcp',
        expiresAt: { gt: new Date(Date.now() + 7 * 86400000) },
      },
    });
    if (!session) {
      session = await this.prisma.session.create({
        data: {
          userId,
          authMethod: 'otp',
          deviceName: 'sandbox-mcp',
          expiresAt: new Date(Date.now() + 60 * 86400000),
        },
      });
    }
    return new SignJWT({
      type: 'mcp',
      email: user.email,
      name: user.username,
      externalAuthId: user.externalAuthId,
      authMethod: 'otp',
      sessionId: session.id,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('60d')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }

  private async buildSecretInput(userId: string, keys: string[], setupScript: string | null) {
    const [user, credential, mcpToken] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { githubAccessToken: true },
      }),
      this.prisma.sandboxCredential.findUnique({ where: { userId } }),
      this.mintMcpToken(userId).catch(() => null),
    ]);
    return {
      authorizedKeys: keys,
      githubToken: user?.githubAccessToken || null,
      claudeToken: credential?.claudeToken ? this.crypto.decrypt(credential.claudeToken) : null,
      openaiToken: credential?.openaiToken ? this.crypto.decrypt(credential.openaiToken) : null,
      setupScript,
      mcpToken,
    };
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
    },
  ): Promise<SandboxDto> {
    const organizationId = await this.resolveOrganization(userId, body.organizationId);
    const setupScript = this.validateSetupScript(body.setupScript);
    const identity = await this.resolveIdentity(userId, body.sshIdentityId);
    const [count, user] = await Promise.all([
      this.prisma.sandbox.count({ where: { userId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { maxSandboxes: true } }),
    ]);
    const cap = user?.maxSandboxes ?? defaultMaxSandboxes();
    if (count >= cap) {
      throw new ForbiddenException(
        `Sandbox limit reached (${count} of ${cap}). Ask an admin to raise your limit.`,
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
        select: { id: true },
      });
      if (existing) name = `sandbox-${Math.random().toString(36).slice(2, 6)}`;
    }
    const row = await this.prisma.sandbox
      .create({
        data: {
          userId,
          organizationId,
          name,
          status: 'creating',
          podName: '',
          namespace: this.k8s.namespace,
          image: process.env.SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE,
          repoUrl: body.repoUrl || null,
          sshIdentityId: identity.id,
          setupScript,
          cpuLimit: process.env.SANDBOX_CPU_LIMIT || '2',
          memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || '4Gi',
          diskSize: process.env.SANDBOX_DISK_SIZE || '10Gi',
        },
      })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${name}"`);
        }
        throw e;
      });
    const podName = `sbx-${row.id}`;
    const updated = await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { podName },
      include: { sshIdentity: { select: { id: true, name: true } } },
    });

    this.audit
      .log({
        action: 'sandbox.create',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: name,
        metadata: { repoUrl: body.repoUrl || null },
      })
      .catch(() => {});

    try {
      const secret = await this.buildSecretInput(userId, [identity.publicKey], setupScript);
      await this.k8s.createSandbox(
        {
          id: row.id,
          podName,
          userId,
          repoUrl: updated.repoUrl,
          image: updated.image,
          cpuLimit: updated.cpuLimit,
          memoryLimit: updated.memoryLimit,
          diskSize: updated.diskSize,
          setupScript,
        },
        secret,
      );
    } catch (e: any) {
      this.logger.error(`sandbox ${row.id} create failed: ${k8sErrorMessage(e)}`);
      const failed = await this.prisma.sandbox.update({
        where: { id: row.id },
        data: { status: 'error', statusMessage: `Failed to create sandbox: ${k8sErrorMessage(e)}` },
        include: { sshIdentity: { select: { id: true, name: true } } },
      });
      return toSandboxDto(failed);
    }
    return toSandboxDto(updated);
  }

  async update(
    id: string,
    userId: string,
    actorEmail: string | null,
    body: {
      name?: string;
      sshIdentityId?: string;
      setupScript?: string | null;
    },
  ): Promise<SandboxDto> {
    const row = await this.getOwnedStrict(id, userId);
    const data: { name?: string; sshIdentityId?: string; setupScript?: string | null } = {};
    let identityKey: string | null = null;
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
      identityKey = identity.publicKey;
    }
    const updated = await this.prisma.sandbox
      .update({
        where: { id: row.id },
        data,
        include: { sshIdentity: { select: { id: true, name: true, publicKey: true } } },
      })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${data.name}"`);
        }
        throw e;
      });
    if (data.sshIdentityId !== undefined || data.setupScript !== undefined) {
      const key = identityKey ?? updated.sshIdentity?.publicKey ?? null;
      const secret = await this.buildSecretInput(
        row.userId,
        key ? [key] : [],
        updated.setupScript,
      );
      await this.k8s.ensureAuthSecret(
        {
          id: updated.id,
          podName: updated.podName,
          userId: updated.userId,
          repoUrl: updated.repoUrl,
          image: updated.image,
          cpuLimit: updated.cpuLimit,
          memoryLimit: updated.memoryLimit,
          diskSize: updated.diskSize,
          setupScript: updated.setupScript,
        },
        secret,
      );
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
            setupScript: data.setupScript === undefined ? 'unchanged' : data.setupScript ? 'set' : 'cleared',
          },
        })
        .catch(() => {});
    }
    return toSandboxDto(updated);
  }

  async start(id: string, userId: string, actorEmail: string | null): Promise<SandboxDto> {
    const row = await this.getOwned(id, userId);
    if (row.status === 'running' || row.status === 'starting') return toSandboxDto(row);
    if (row.status === 'deleting') throw new BadRequestException('Sandbox is being deleted');
    const rebuilt = await this.ensureRunning(row);
    // A start against a sandbox the cluster never actually stopped changes
    // nothing about the resource, so no watch event is coming and nothing would
    // move the row off "starting". Settle it here when the box is already up.
    const settled = sandboxStatusFromCr(await this.k8s.getCrStatus(row.podName));
    const updated = await this.prisma.sandbox.update({
      where: { id: row.id },
      data: {
        status: settled === 'running' ? 'running' : 'starting',
        statusMessage: null,
        lastActiveAt: new Date(),
      },
      include: { sshIdentity: { select: { id: true, name: true } } },
    });
    this.audit
      .log({
        action: 'sandbox.start',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
        metadata: { rebuilt },
      })
      .catch(() => {});
    return toSandboxDto(updated);
  }

  async stop(id: string, userId: string, actorEmail: string | null): Promise<SandboxDto> {
    const row = await this.getOwned(id, userId);
    if (row.status === 'stopped' || row.status === 'stopping') return toSandboxDto(row);
    if (row.status === 'deleting') throw new BadRequestException('Sandbox is being deleted');
    // Same shape as start: a resource that is already gone, or already
    // suspended, produces no event, and the row would sit in stopping waiting
    // for one that cannot arrive.
    const existed = await this.k8s.suspend(row.podName);
    const settled = sandboxStatusFromCr(await this.k8s.getCrStatus(row.podName));
    const updated = await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { status: !existed || settled === 'stopped' ? 'stopped' : 'stopping' },
      include: { sshIdentity: { select: { id: true, name: true } } },
    });
    this.audit
      .log({
        action: 'sandbox.stop',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
      })
      .catch(() => {});
    return toSandboxDto(updated);
  }

  async remove(id: string, userId: string, actorEmail: string | null): Promise<void> {
    const row = await this.getOwned(id, userId);
    await this.prisma.sandbox.update({ where: { id: row.id }, data: { status: 'deleting' } });
    try {
      await this.k8s.deleteSandbox({ id: row.id, podName: row.podName });
    } catch (e: any) {
      this.logger.error(`sandbox ${row.id} delete failed: ${k8sErrorMessage(e)}`);
      await this.prisma.sandbox.update({
        where: { id: row.id },
        data: { status: 'error', statusMessage: `Failed to delete sandbox: ${k8sErrorMessage(e)}` },
      });
      throw e;
    }
    await this.prisma.sandbox.delete({ where: { id: row.id } });
    this.audit
      .log({
        action: 'sandbox.delete',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
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
    body: { claudeToken?: string | null; openaiToken?: string | null },
  ): Promise<{ claude: boolean; openai: boolean }> {
    const wantsWrite =
      (typeof body.claudeToken === 'string' && body.claudeToken.length > 0) ||
      (typeof body.openaiToken === 'string' && body.openaiToken.length > 0);
    if (wantsWrite && !this.crypto.enabled) {
      throw new ServiceUnavailableException(
        'SECRETS_ENCRYPTION_KEY is not configured; refusing to store agent tokens in plaintext',
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
      update: data,
    });
    const rows = await this.prisma.sandbox.findMany({
      where: { userId },
      include: { sshIdentity: { select: { publicKey: true } } },
    });
    for (const row of rows) {
      try {
        const secret = await this.buildSecretInput(
          userId,
          row.sshIdentity ? [row.sshIdentity.publicKey] : [],
          row.setupScript,
        );
        await this.k8s.ensureAuthSecret(
          {
            id: row.id,
            podName: row.podName,
            userId: row.userId,
            repoUrl: row.repoUrl,
            image: row.image,
            cpuLimit: row.cpuLimit,
            memoryLimit: row.memoryLimit,
            diskSize: row.diskSize,
            setupScript: row.setupScript,
          },
          secret,
        );
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
          claude: body.claudeToken === undefined ? 'unchanged' : body.claudeToken ? 'set' : 'cleared',
          openai: body.openaiToken === undefined ? 'unchanged' : body.openaiToken ? 'set' : 'cleared',
        },
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
