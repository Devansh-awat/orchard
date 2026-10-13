import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SshIdentity } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { SandboxRunnerRegistry } from '../sandboxes/runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, refOf } from '../sandboxes/runners/sandbox-runner';

const SSH_KEY_RE = /^(ssh-(rsa|ed25519)|ecdsa-sha2-\S+)\s+\S+/;
const MAX_KEY_LENGTH = 4096;
const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9 ._-]*[a-zA-Z0-9])?$/;

export interface SshIdentityDto {
  id: string;
  name: string;
  publicKey: string;
  createdAt: Date;
}

export function toSshIdentityDto(row: SshIdentity): SshIdentityDto {
  return { id: row.id, name: row.name, publicKey: row.publicKey, createdAt: row.createdAt };
}

@Injectable()
export class SshIdentitiesService {
  private readonly logger = new Logger(SshIdentitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef
  ) {}

  private registry(): SandboxRunnerRegistry | null {
    try {
      return this.moduleRef.get(SandboxRunnerRegistry, { strict: false });
    } catch {
      return null;
    }
  }

  async refreshSandboxKeys(userId: string): Promise<number> {
    const registry = this.registry();
    if (!registry) return 0;
    const rows = await this.prisma.sandbox.findMany({
      where: { userId, desiredState: { not: 'deleted' } },
      select: SANDBOX_REF_SELECT
    });
    let queued = 0;
    for (const row of rows) {
      try {
        await registry.for(row).requestSecretSync(refOf(row), userId);
        queued += 1;
      } catch (e: any) {
        this.logger.warn(`could not queue a key refresh for sandbox ${row.id}: ${e?.message}`);
      }
    }
    return queued;
  }

  async list(userId: string): Promise<SshIdentityDto[]> {
    const rows = await this.prisma.sshIdentity.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' }
    });
    return rows.map(toSshIdentityDto);
  }

  private validate(name: string, publicKey: string): void {
    if (!name || name.length > 100 || !NAME_RE.test(name)) {
      throw new BadRequestException(
        'Identity name must be 1-100 characters (letters, numbers, spaces, ._-)'
      );
    }
    const key = publicKey.trim();
    if (!key || key.length > MAX_KEY_LENGTH || !SSH_KEY_RE.test(key) || key.includes('\n')) {
      throw new BadRequestException('publicKey must be a single OpenSSH public key');
    }
  }

  async create(
    userId: string,
    body: { name?: string; publicKey?: string }
  ): Promise<SshIdentityDto> {
    const name = (body.name || '').trim();
    const publicKey = (body.publicKey || '').trim();
    this.validate(name, publicKey);
    const row = await this.prisma.sshIdentity
      .create({ data: { userId, name, publicKey } })
      .catch((e) => {
        if (e?.code === 'P2002') {
          throw new ConflictException(`You already have an identity named "${name}"`);
        }
        throw e;
      });
    await this.refreshSandboxKeys(userId);
    return toSshIdentityDto(row);
  }

  async remove(id: string, userId: string): Promise<void> {
    const row = await this.prisma.sshIdentity.findUnique({
      where: { id },
      include: { sandboxes: { select: { name: true } } }
    });
    if (!row || row.userId !== userId) throw new NotFoundException('SSH identity not found');
    if (row.sandboxes.length) {
      throw new ConflictException(
        `Identity is attached to sandbox ${row.sandboxes.map((s) => `"${s.name}"`).join(', ')}; detach it first`
      );
    }
    await this.prisma.sshIdentity.delete({ where: { id } });
    await this.refreshSandboxKeys(userId);
  }

  async importFromGithub(userId: string): Promise<SshIdentityDto[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubUsername: true }
    });
    if (!user?.githubUsername) {
      throw new BadRequestException('No GitHub account is linked to your user');
    }
    let keys: string[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://github.com/${user.githubUsername}.keys`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        keys = (await res.text())
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => SSH_KEY_RE.test(l));
      }
    } catch {
      throw new BadRequestException('Could not fetch keys from GitHub');
    }
    if (!keys.length) {
      throw new BadRequestException(`No public keys found on github.com/${user.githubUsername}`);
    }
    const existing = await this.prisma.sshIdentity.findMany({
      where: { userId },
      select: { name: true, publicKey: true }
    });
    const existingKeys = new Set(existing.map((r) => r.publicKey.trim()));
    const existingNames = new Set(existing.map((r) => r.name));
    const created: SshIdentityDto[] = [];
    let n = 1;
    for (const key of keys) {
      if (existingKeys.has(key)) continue;
      let name = `github-${n}`;
      while (existingNames.has(name)) {
        n += 1;
        name = `github-${n}`;
      }
      existingNames.add(name);
      const row = await this.prisma.sshIdentity.create({
        data: { userId, name, publicKey: key }
      });
      created.push(toSshIdentityDto(row));
      n += 1;
    }
    if (created.length) await this.refreshSandboxKeys(userId);
    return created;
  }
}
