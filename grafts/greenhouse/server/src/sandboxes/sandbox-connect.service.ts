import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxNotRunningError, SandboxRowLike, refOf } from './runners/sandbox-runner';

const HOST_KEY_RE =
  /^((?:ssh|sk-ssh)-[a-z0-9@.-]+|ecdsa-sha2-[a-z0-9-]+|sk-ecdsa-sha2-[a-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s|$)/;
const HOST_KEY_SCRIPT = 'cat /persist/hostkeys/*.pub 2>/dev/null';

export const SANDBOX_SSH_USER = 'dev';

export function parseHostKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split('\n')) {
    const match = HOST_KEY_RE.exec(line.trim());
    if (!match) continue;
    const key = `${match[1]} ${match[2]}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.sort();
}

export function cachedHostKeys(runnerState: unknown): string[] {
  const value = (runnerState as { hostKeys?: unknown } | null)?.hostKeys;
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
}

export function sandboxSshHost(name: string): string {
  return `orchard-${name}`;
}

@Injectable()
export class SandboxConnectService {
  private readonly logger = new Logger(SandboxConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry
  ) {}

  async hostKeys(row: SandboxRowLike & { status: string }): Promise<{ publicKeys: string[] }> {
    const cached = cachedHostKeys(row.runnerState);
    if (row.status !== 'running') return { publicKeys: cached };
    let fresh: string[] = [];
    try {
      const result = await this.registry
        .for(row)
        .exec(refOf(row), ['/bin/sh', '-c', HOST_KEY_SCRIPT], { timeoutMs: 8000 });
      fresh = parseHostKeys(result.stdout);
    } catch (e: any) {
      if (!(e instanceof SandboxNotRunningError)) {
        this.logger.warn(`could not read host keys of sandbox ${row.id}: ${e?.message}`);
      }
      return { publicKeys: cached };
    }
    if (fresh.length === 0) return { publicKeys: cached };
    if (fresh.join('\n') !== cached.join('\n')) await this.remember(row.id, fresh);
    return { publicKeys: fresh };
  }

  private async remember(id: string, hostKeys: string[]): Promise<void> {
    const current = await this.prisma.sandbox.findUnique({
      where: { id },
      select: { runnerState: true }
    });
    if (!current) return;
    const state =
      current.runnerState &&
      typeof current.runnerState === 'object' &&
      !Array.isArray(current.runnerState)
        ? (current.runnerState as Record<string, unknown>)
        : {};
    await this.prisma.sandbox.updateMany({
      where: { id },
      data: { runnerState: { ...state, hostKeys } }
    });
  }

  async connectInfo(row: {
    name: string;
    userId: string;
  }): Promise<{ sshHost: string; user: string; sshReady: boolean }> {
    const identities = await this.prisma.sshIdentity.count({ where: { userId: row.userId } });
    return { sshHost: sandboxSshHost(row.name), user: SANDBOX_SSH_USER, sshReady: identities > 0 };
  }
}
