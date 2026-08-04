import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Sandbox, SandboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { SandboxK8sService } from './sandbox-k8s.service';

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SSH_KEY_RE = /^(ssh-(rsa|ed25519)|ecdsa-sha2-\S+)\s+\S+/;
const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 4096;

export interface SandboxDto {
  id: string;
  name: string;
  status: SandboxStatus;
  statusMessage: string | null;
  repoUrl: string | null;
  sshPublicKeys: string[];
  image: string;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date | null;
}

export function defaultMaxSandboxes(): number {
  const parsed = Number(process.env.SANDBOX_MAX_PER_USER);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

export function toSandboxDto(row: Sandbox): SandboxDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusMessage: row.statusMessage,
    repoUrl: row.repoUrl,
    sshPublicKeys: row.sshPublicKeys,
    image: row.image,
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

  async list(userId: string): Promise<{ sandboxes: SandboxDto[]; maxSandboxes: number }> {
    const [rows, user] = await Promise.all([
      this.prisma.sandbox.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { maxSandboxes: true } }),
    ]);
    return {
      sandboxes: rows.map(toSandboxDto),
      maxSandboxes: user?.maxSandboxes ?? defaultMaxSandboxes(),
    };
  }

  async getOwned(id: string, userId: string): Promise<Sandbox> {
    const row = await this.prisma.sandbox.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Sandbox not found');
    if (row.userId !== userId && !(await this.authz.isSuperAdmin(userId))) {
      throw new NotFoundException('Sandbox not found');
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

  private validateKeys(keys: string[]): string[] {
    const cleaned = keys.map((k) => k.trim()).filter(Boolean);
    if (cleaned.length > MAX_KEYS) {
      throw new BadRequestException(`At most ${MAX_KEYS} SSH public keys are allowed`);
    }
    for (const key of cleaned) {
      if (key.length > MAX_KEY_LENGTH || !SSH_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid SSH public key: ${key.slice(0, 40)}...`);
      }
    }
    return [...new Set(cleaned)];
  }

  private async fetchGithubKeys(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubUsername: true },
    });
    if (!user?.githubUsername) return [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://github.com/${user.githubUsername}.keys`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return [];
      const text = await res.text();
      return text.split('\n').map((l) => l.trim()).filter((l) => SSH_KEY_RE.test(l));
    } catch {
      return [];
    }
  }

  private async resolveKeys(
    userId: string,
    provided: string[] | undefined,
    importGithubKeys: boolean | undefined,
  ): Promise<string[]> {
    const keys = this.validateKeys(provided ?? []);
    if (importGithubKeys) {
      const githubKeys = await this.fetchGithubKeys(userId);
      for (const key of githubKeys) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
    if (keys.length > MAX_KEYS) keys.length = MAX_KEYS;
    return keys;
  }

  private async buildSecretInput(userId: string, keys: string[]) {
    const [user, credential] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { githubAccessToken: true },
      }),
      this.prisma.sandboxCredential.findUnique({ where: { userId } }),
    ]);
    return {
      authorizedKeys: keys,
      githubToken: user?.githubAccessToken || null,
      claudeToken: credential?.claudeToken ? this.crypto.decrypt(credential.claudeToken) : null,
      openaiToken: credential?.openaiToken ? this.crypto.decrypt(credential.openaiToken) : null,
    };
  }

  async create(
    userId: string,
    actorEmail: string | null,
    body: { name?: string; repoUrl?: string; sshPublicKeys?: string[]; importGithubKeys?: boolean },
  ): Promise<SandboxDto> {
    if (!process.env.SANDBOX_IMAGE) {
      throw new ServiceUnavailableException('SANDBOX_IMAGE is not configured on this server');
    }
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
    const keys = await this.resolveKeys(userId, body.sshPublicKeys, body.importGithubKeys);
    if (!keys.length) {
      throw new BadRequestException(
        'At least one SSH public key is required (provide sshPublicKeys or set importGithubKeys)',
      );
    }

    const row = await this.prisma.sandbox
      .create({
        data: {
          userId,
          name,
          status: 'creating',
          podName: '',
          namespace: this.k8s.namespace,
          image: process.env.SANDBOX_IMAGE,
          repoUrl: body.repoUrl || null,
          sshPublicKeys: keys,
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
    const updated = await this.prisma.sandbox.update({ where: { id: row.id }, data: { podName } });

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
      const secret = await this.buildSecretInput(userId, keys);
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
        },
        secret,
      );
    } catch (e: any) {
      this.logger.error(`sandbox ${row.id} create failed: ${e?.message}`);
      const failed = await this.prisma.sandbox.update({
        where: { id: row.id },
        data: { status: 'error', statusMessage: `Failed to create sandbox: ${e?.message}` },
      });
      return toSandboxDto(failed);
    }
    return toSandboxDto(updated);
  }

  async update(
    id: string,
    userId: string,
    actorEmail: string | null,
    body: { name?: string; sshPublicKeys?: string[]; importGithubKeys?: boolean },
  ): Promise<SandboxDto> {
    const row = await this.getOwned(id, userId);
    const data: { name?: string; sshPublicKeys?: string[] } = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      this.validateName(name);
      data.name = name;
    }
    if (body.sshPublicKeys !== undefined || body.importGithubKeys) {
      const keys = await this.resolveKeys(
        row.userId,
        body.sshPublicKeys ?? row.sshPublicKeys,
        body.importGithubKeys,
      );
      if (!keys.length) {
        throw new BadRequestException('A sandbox must keep at least one SSH public key');
      }
      data.sshPublicKeys = keys;
    }
    const updated = await this.prisma.sandbox
      .update({ where: { id: row.id }, data })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new BadRequestException(`You already have a sandbox named "${data.name}"`);
        }
        throw e;
      });
    if (data.sshPublicKeys) {
      const secret = await this.buildSecretInput(row.userId, data.sshPublicKeys);
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
          metadata: { keyCount: data.sshPublicKeys.length },
        })
        .catch(() => {});
    }
    return toSandboxDto(updated);
  }

  async start(id: string, userId: string, actorEmail: string | null): Promise<SandboxDto> {
    const row = await this.getOwned(id, userId);
    if (row.status === 'running' || row.status === 'starting') return toSandboxDto(row);
    if (row.status === 'deleting') throw new BadRequestException('Sandbox is being deleted');
    await this.k8s.resume(row.podName);
    const updated = await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { status: 'starting', statusMessage: null, lastActiveAt: new Date() },
    });
    this.audit
      .log({
        action: 'sandbox.start',
        actorUserId: userId,
        actorEmail,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
      })
      .catch(() => {});
    return toSandboxDto(updated);
  }

  async stop(id: string, userId: string, actorEmail: string | null): Promise<SandboxDto> {
    const row = await this.getOwned(id, userId);
    if (row.status === 'stopped' || row.status === 'stopping') return toSandboxDto(row);
    if (row.status === 'deleting') throw new BadRequestException('Sandbox is being deleted');
    await this.k8s.suspend(row.podName);
    const updated = await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { status: 'stopping' },
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
      this.logger.error(`sandbox ${row.id} delete failed: ${e?.message}`);
      await this.prisma.sandbox.update({
        where: { id: row.id },
        data: { status: 'error', statusMessage: `Failed to delete sandbox: ${e?.message}` },
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
    const data: { claudeToken?: string | null; openaiToken?: string | null } = {};
    if (body.claudeToken !== undefined) {
      data.claudeToken = body.claudeToken ? this.crypto.encrypt(body.claudeToken) : null;
    }
    if (body.openaiToken !== undefined) {
      data.openaiToken = body.openaiToken ? this.crypto.encrypt(body.openaiToken) : null;
    }
    await this.prisma.sandboxCredential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
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
