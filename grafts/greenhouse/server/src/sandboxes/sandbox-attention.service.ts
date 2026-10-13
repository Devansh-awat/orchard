import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LeaderElectionService } from '../core/leader-election.service';
import { InstanceSettingsService } from '../core/instance-settings.service';
import { NotificationsService } from '../core/notifications.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxLiveService } from './live/sandbox-live.service';
import { SessionActivity, activityFromStatus } from './sandbox-sessions.service';
import { isWorktreePath } from './sandbox-session-commands';

const POLL_MS = 20_000;
const WATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_SANDBOXES_PER_TICK = 50;

export function needsAttention(previous: SessionActivity | undefined, next: SessionActivity) {
  return previous === 'working' && next === 'idle';
}

@Injectable()
export class SandboxAttentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxAttentionService.name);

  private readonly state = new Map<string, SessionActivity>();

  private timer: ReturnType<typeof setInterval> | null = null;

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly settings: InstanceSettingsService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly live: SandboxLiveService,
    @Optional() private readonly notifications?: NotificationsService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || !this.notifications) return;
    if (!this.leader.isLeader()) {
      this.state.clear();
      return;
    }
    if (!(await this.settings.isSandboxesEnabled().catch(() => false))) return;
    this.running = true;
    try {
      await this.scan();
    } catch (e: any) {
      this.logger.warn(`attention scan failed: ${e?.message}`);
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const since = new Date(Date.now() - WATCH_WINDOW_MS);
    const recent = await this.prisma.sandboxPromptAuthor.findMany({
      where: { createdAt: { gte: since }, sessionKey: { not: null } },
      distinct: ['sessionKey'],
      select: { sessionKey: true }
    });
    const ids = recent.map((r) => r.sessionKey).filter((id): id is string => !!id);
    const seen = new Set(ids);
    for (const key of [...this.state.keys()]) if (!seen.has(key)) this.state.delete(key);
    if (ids.length === 0) return;
    const sessions = await this.prisma.sandboxConversation.findMany({
      where: { id: { in: ids }, archivedAt: null, sandbox: { status: 'running' } },
      select: {
        id: true,
        title: true,
        worktreePath: true,
        sandbox: {
          select: {
            id: true,
            name: true,
            userId: true,
            status: true,
            repoUrl: true,
            runner: true,
            podName: true,
            namespace: true,
            externalId: true,
            runnerState: true
          }
        }
      }
    });
    const bySandbox = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (!isWorktreePath(session.worktreePath)) continue;
      const list = bySandbox.get(session.sandbox.id) ?? [];
      list.push(session);
      bySandbox.set(session.sandbox.id, list);
    }
    for (const list of [...bySandbox.values()].slice(0, MAX_SANDBOXES_PER_TICK)) {
      const sandbox = list[0].sandbox;
      for (const session of list) {
        let next: SessionActivity;
        try {
          const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session/status', {
            directory: session.worktreePath,
            timeoutMs: STATUS_TIMEOUT_MS
          });
          if (res.status !== 200) continue;
          next = activityFromStatus(res.body);
        } catch {
          continue;
        }
        const previous = this.state.get(session.id);
        this.state.set(session.id, next);
        if (!needsAttention(previous, next)) continue;
        await this.notify(sandbox, session).catch((e: any) =>
          this.logger.warn(`needs_input notification failed: ${e?.message}`)
        );
      }
    }
  }

  private async notify(
    sandbox: { id: string; name: string; userId: string },
    session: { id: string; title: string }
  ): Promise<void> {
    const authors = await this.prisma.sandboxPromptAuthor.findMany({
      where: { sessionKey: session.id, createdAt: { gte: new Date(Date.now() - WATCH_WINDOW_MS) } },
      distinct: ['userId'],
      select: { userId: true }
    });
    const recipients = new Set<string>([sandbox.userId, ...authors.map((a) => a.userId)]);
    const present = await this.live.connectedUserIds(sandbox.id).catch(() => new Set<string>());
    const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const bucket = Math.floor(Date.now() / 60_000);
    for (const userId of recipients) {
      if (present.has(userId)) continue;
      const allowed = await this.prisma.sandboxMember.count({
        where: { sandboxId: sandbox.id, userId }
      });
      if (userId !== sandbox.userId && allowed === 0) continue;
      await this.notifications!.notifyAccount(
        userId,
        {
          event: 'sandbox.session.needs_input',
          title: `"${session.title}" is waiting for you`,
          body: `The agent finished its turn in ${sandbox.name} and is waiting for the next prompt.`,
          url: `${frontend}/sandboxes/${sandbox.id}?session=${session.id}`,
          targetId: session.id,
          targetName: session.title
        },
        `sandbox.session.needs_input:${session.id}:${userId}:${bucket}`
      );
    }
  }
}
