import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SANDBOX_REF_SELECT } from './runners/sandbox-runner';
import { SandboxWorkspaceService, type WorkspaceSandbox } from './sandbox-workspace.service';
import { SandboxGitActorService } from './sandbox-git-identity';
import { SandboxMembersService, type RecordedPrompt } from './sandbox-members.service';
import { HOME_ROOT, isWorktreePath } from './sandbox-session-commands';
import { buildCoauthorUpdate, coauthorLine, type CoauthorUpdate } from './sandbox-coauthors';

const STATUS_TIMEOUT_MS = 2_000;
const WRITE_TIMEOUT_MS = 15_000;

@Injectable()
export class SandboxCoauthorsService {
  private readonly logger = new Logger(SandboxCoauthorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly gitActors: SandboxGitActorService,
    members: SandboxMembersService
  ) {
    members.setPromptListener((prompt) => this.onPrompt(prompt));
  }

  async turnMode(
    sandbox: WorkspaceSandbox,
    directory: string,
    chatId: string
  ): Promise<CoauthorUpdate> {
    try {
      const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session/status', {
        directory,
        timeoutMs: STATUS_TIMEOUT_MS
      });
      if (res.status !== 200 || !res.body || typeof res.body !== 'object') return 'append';
      const entry = (res.body as Record<string, { type?: unknown } | undefined>)[chatId];
      return entry?.type === 'busy' || entry?.type === 'retry' ? 'append' : 'reset';
    } catch {
      return 'append';
    }
  }

  async onPrompt(
    prompt: RecordedPrompt
  ): Promise<{ mode: CoauthorUpdate; line: string; written: Promise<void> } | null> {
    if (!prompt.sessionKey) return null;
    const [session, sandbox] = await Promise.all([
      this.prisma.sandboxConversation.findFirst({
        where: { id: prompt.sessionKey, sandboxId: prompt.sandboxId },
        select: { id: true, worktreePath: true, archivedAt: true }
      }),
      this.prisma.sandbox.findUnique({
        where: { id: prompt.sandboxId },
        select: { ...SANDBOX_REF_SELECT, status: true, repoUrl: true }
      })
    ]);
    if (!session || session.archivedAt || !isWorktreePath(session.worktreePath)) return null;
    if (!sandbox || sandbox.status !== 'running') return null;
    const mode = prompt.fresh
      ? 'reset'
      : await this.turnMode(sandbox, session.worktreePath, prompt.chatId);
    let line = '';
    if (prompt.userId !== sandbox.userId) {
      const identity = await this.gitActors.describe(prompt.userId).catch(() => null);
      line = identity ? (coauthorLine(identity) ?? '') : '';
    }
    if (!line && mode === 'append') return null;
    const written = this.workspace
      .runIn(sandbox, HOME_ROOT, null, buildCoauthorUpdate(session.id, mode), {
        stdin: Buffer.from(`${line}\n`, 'utf8'),
        timeoutMs: WRITE_TIMEOUT_MS
      })
      .then((result) => {
        if (!result.ok) this.logger.warn(`co-author list update exited ${result.exitCode}`);
      })
      .catch((e) => this.logger.warn(`co-author list update failed: ${e?.message}`));
    return { mode, line, written };
  }
}
