import { SANDBOX_MCP_DEVICE, sandboxMcpDevice } from '../auth/sandbox-mcp-scope';
import { refOf, type SandboxRowLike } from './runners/sandbox-runner';
import { isUuid } from './sandbox-session-commands';

export interface McpRotationPrisma {
  sandbox: {
    updateMany(args: {
      where: { id: string };
      data: { secretEpoch: { increment: number } };
    }): Promise<{ count: number }>;
  };
  session: {
    updateMany(args: {
      where: { userId: string; deviceName: { in: string[] }; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface McpRotationRegistry {
  for(row: SandboxRowLike): {
    requestSecretSync(ref: ReturnType<typeof refOf>, requestedById?: string | null): Promise<void>;
  };
}

export interface GuestShellRegistry {
  for(row: SandboxRowLike): {
    exec(
      ref: ReturnType<typeof refOf>,
      command: string[],
      opts?: { timeoutMs?: number }
    ): Promise<unknown>;
  };
}

export function guestShellKillScript(userId: string): string {
  if (!isUuid(userId)) throw new Error('invalid user id');
  const suffix = `-u${userId.replace(/-/g, '').toLowerCase()}`;
  return [
    'command -v tmux >/dev/null 2>&1 || exit 0',
    `tmux ls -F '#{session_name}' 2>/dev/null | while IFS= read -r s; do case "$s" in orchard-*${suffix}) tmux kill-session -t "=$s" ;; esac; done`,
    'exit 0'
  ].join('\n');
}

export async function endGuestShells(
  registry: GuestShellRegistry | null,
  sandbox: SandboxRowLike & { status: string },
  userId: string
): Promise<void> {
  if (!registry || sandbox.status !== 'running') return;
  await registry
    .for(sandbox)
    .exec(refOf(sandbox), ['su', '-l', 'dev', '-c', guestShellKillScript(userId)], {
      timeoutMs: 15_000
    });
}

export async function rotateMachineSecrets(
  prisma: McpRotationPrisma,
  registry: McpRotationRegistry | null,
  sandbox: SandboxRowLike & { organizationId: string | null },
  requestedById: string
): Promise<number> {
  await prisma.sandbox.updateMany({
    where: { id: sandbox.id },
    data: { secretEpoch: { increment: 1 } }
  });
  await prisma.session.updateMany({
    where: {
      userId: sandbox.userId,
      deviceName: {
        in: [SANDBOX_MCP_DEVICE, sandboxMcpDevice(sandbox.organizationId, sandbox.id)]
      },
      revokedAt: null
    },
    data: { revokedAt: new Date() }
  });
  if (!registry) return 0;
  await registry.for(sandbox).requestSecretSync(refOf(sandbox), requestedById);
  return 1;
}
