import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { SandboxConversation } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { refOf, SandboxNotRunningError } from '../runners/sandbox-runner';
import type { WorkspaceSandbox } from '../sandbox-workspace.service';
import { isWorktreePath } from '../sandbox-session-commands';
import { SandboxLiveService } from '../live/sandbox-live.service';
import { SandboxAttentionService } from '../sandbox-attention.service';
import {
  SandboxSessionsService,
  type PoolClaim,
  type SessionActivity,
  type SessionAgentHost
} from '../sandbox-sessions.service';
import { PUBLIC_USER_SELECT, publicUser, type PublicUser } from '../sandbox-members.service';
import { DaemonRpcError, DaemonUnavailableError } from './daemon-connection';
import {
  SandboxDaemonService,
  type DaemonActivity,
  type DaemonEvent
} from './sandbox-daemon.service';

export const AGENT_CHAT_ID_RE = /^acp_[0-9a-f]{24}$/;
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CONFIG_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_PROMPT_CHARS = 32768;
const MAX_TITLE = 200;

export type AgentActivity = 'idle' | 'working' | 'needs_input';

export interface AgentCatalogEntry {
  id: string;
  label: string;
  installed: boolean;
  available: boolean;
  error?: string;
  version?: string;
  configOptions?: unknown;
  models?: unknown;
  modes?: unknown;
}

export interface AgentChatDto {
  id: string;
  sessionId: string;
  agent: string;
  title: string;
  createdAt: Date;
  createdBy: PublicUser | null;
  activity: AgentActivity;
  lastSeq: number;
  configOptions: unknown;
  running: boolean;
  queued: number;
}

interface DaemonChatState {
  id: string;
  agent: string;
  cwd: string;
  title?: string;
  activity: AgentActivity;
  lastSeq: number;
  running: boolean;
  queued: number;
  configOptions?: unknown;
  agentSessionId?: string;
  permissions?: { requestId: string }[];
}

export function newAgentChatId(): string {
  return `acp_${randomBytes(12).toString('hex')}`;
}

export function activityRank(activity: AgentActivity | undefined): number {
  return activity === 'needs_input' ? 2 : activity === 'working' ? 1 : 0;
}

export function mergeActivity(
  a: AgentActivity | undefined,
  b: AgentActivity | undefined
): AgentActivity {
  return activityRank(a) >= activityRank(b) ? (a ?? 'idle') : (b ?? 'idle');
}

function wrap(e: unknown): never {
  if (e instanceof DaemonUnavailableError) {
    throw new ServiceUnavailableException('The agent host on this machine is not reachable yet');
  }
  if (e instanceof DaemonRpcError) {
    if (e.code === -32004) throw new NotFoundException(e.message);
    if (e.code === -32009) throw new ConflictException(e.message);
    if (e.code === -32602) throw new BadRequestException(e.message);
    if (e.code === -32010) throw new ServiceUnavailableException(e.message);
    throw new BadGatewayException(e.message);
  }
  throw e;
}

@Injectable()
export class SandboxAgentHostService implements OnModuleInit, SessionAgentHost {
  private readonly logger = new Logger(SandboxAgentHostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly daemon: SandboxDaemonService,
    @Optional() private readonly live?: SandboxLiveService,
    @Optional() private readonly sessions?: SandboxSessionsService,
    @Optional() attention?: SandboxAttentionService
  ) {
    sessions?.setAgentHost(this);
    attention?.setAcpActivity(async (sandbox, dirs) => {
      const map = await this.activityByWorktree(sandbox as unknown as WorkspaceSandbox, dirs);
      const out = new Map<string, SessionActivity>();
      for (const [dir, activity] of map) out.set(dir, activity);
      return out;
    });
    sessions?.setAcpActivity(async (sandbox, dirs) => {
      const map = await this.activityByWorktree(sandbox, dirs);
      const out = new Map<string, SessionActivity>();
      for (const [dir, activity] of map) out.set(dir, activity);
      return out;
    });
  }

  async claim(
    sandbox: WorkspaceSandbox,
    input: {
      repo: string;
      base: string | null;
      branch: string;
      agent: string | null;
      chatId: string | null;
      title: string;
      prompt: string;
      actorUserId: string;
    }
  ): Promise<PoolClaim | null> {
    if (sandbox.status !== 'running') return null;
    const ref = refOf(sandbox);
    if (!(await this.daemon.available(ref))) return null;
    const author = input.prompt ? await this.author(input.actorUserId) : null;
    return this.daemon.tryCall<PoolClaim>(
      ref,
      'pool.claim',
      {
        repo: input.repo,
        ...(input.base ? { base: input.base } : {}),
        branch: input.branch,
        ...(input.agent && input.chatId
          ? {
              agent: input.agent,
              chatId: input.chatId,
              title: input.title.slice(0, MAX_TITLE),
              ...(input.prompt
                ? { prompt: { text: input.prompt, author, messageId: newMessageId() } }
                : {})
            }
          : {})
      },
      60_000
    );
  }

  async ensurePool(
    sandbox: WorkspaceSandbox,
    input: { repo: string; base: string | null; agent: string | null; setup: string | null }
  ): Promise<void> {
    if (sandbox.status !== 'running' || process.env.SANDBOX_WARM_POOL === 'off') return;
    await this.daemon.tryCall(
      refOf(sandbox),
      'pool.ensure',
      {
        repo: input.repo,
        ...(input.base ? { base: input.base } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.setup ? { setup: input.setup } : {})
      },
      10_000
    );
  }

  async startChat(
    sandbox: WorkspaceSandbox,
    session: { id: string },
    actorUserId: string,
    input: { id: string; agent: string; title: string; prompt: string }
  ): Promise<unknown> {
    return this.createChat(sandbox, session.id, actorUserId, {
      id: input.id,
      agent: input.agent,
      title: input.title,
      prompt: input.prompt
    });
  }

  async adoptChat(
    sandbox: WorkspaceSandbox,
    session: { id: string },
    actorUserId: string,
    chat: { id: string; agent: string },
    title: string
  ): Promise<void> {
    await this.prisma.sandboxChat
      .create({
        data: {
          id: chat.id,
          sandboxId: sandbox.id,
          conversationId: session.id,
          agent: chat.agent,
          title: title.slice(0, MAX_TITLE),
          createdById: actorUserId
        }
      })
      .catch((e: any) => {
        if (e?.code !== 'P2002') throw e;
      });
  }

  async primaryChat(sessionId: string): Promise<string | null> {
    const row = await this.prisma.sandboxChat.findFirst({
      where: { conversationId: sessionId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    });
    return row?.id ?? null;
  }

  async transcript(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    limit: number
  ): Promise<AcpTranscriptMessage[]> {
    const res = await this.events(sandbox, sessionId, chatId, 0);
    return acpTranscript(res.events, limit);
  }

  async primaryChats(conversationIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (conversationIds.length === 0) return out;
    const rows = await this.prisma.sandboxChat.findMany({
      where: { conversationId: { in: conversationIds }, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, conversationId: true }
    });
    for (const row of rows) if (!out.has(row.conversationId)) out.set(row.conversationId, row.id);
    return out;
  }

  onModuleInit() {
    this.daemon.events.on('activity', (sandboxId: string, activity: DaemonActivity) => {
      void this.live
        ?.broadcast(sandboxId, {
          t: 'agent-activity',
          chatId: activity.chatId,
          cwd: activity.cwd,
          activity: activity.activity
        })
        .catch(() => null);
    });
    this.daemon.events.on('catalog', (sandboxId: string, catalog: unknown) => {
      void this.live?.broadcast(sandboxId, { t: 'agent-catalog', catalog }).catch(() => null);
    });
  }

  private requireRunning(sandbox: WorkspaceSandbox) {
    if (sandbox.status !== 'running') throw new SandboxNotRunningError();
  }

  async available(sandbox: WorkspaceSandbox): Promise<boolean> {
    if (sandbox.status !== 'running') return false;
    return this.daemon.available(refOf(sandbox));
  }

  async catalog(
    sandbox: WorkspaceSandbox,
    refresh = false
  ): Promise<{ available: boolean; agents: AgentCatalogEntry[]; probing: boolean }> {
    if (sandbox.status !== 'running') return { available: false, agents: [], probing: false };
    const res = await this.daemon
      .tryCall<{ agents: AgentCatalogEntry[]; probing: boolean }>(
        refOf(sandbox),
        'agent.catalog',
        { refresh },
        10_000
      )
      .catch(() => null);
    if (!res) return { available: false, agents: [], probing: false };
    return { available: true, agents: res.agents ?? [], probing: !!res.probing };
  }

  private async sessionOf(sandboxId: string, sessionId: string): Promise<SandboxConversation> {
    const row = await this.prisma.sandboxConversation.findFirst({
      where: { id: sessionId, sandboxId, slug: { not: null } }
    });
    if (!row) throw new NotFoundException('Session not found');
    if (row.archivedAt) throw new BadRequestException('This session is archived');
    if (!isWorktreePath(row.worktreePath)) {
      throw new BadRequestException('This session has no worktree');
    }
    return row;
  }

  private async chatRow(sandboxId: string, sessionId: string, chatId: string) {
    if (!AGENT_CHAT_ID_RE.test(chatId)) throw new BadRequestException('Invalid chat id');
    const row = await this.prisma.sandboxChat.findFirst({
      where: { id: chatId, sandboxId, conversationId: sessionId }
    });
    if (!row) throw new NotFoundException('Chat not found');
    return row;
  }

  private async creators(ids: (string | null)[]): Promise<Map<string, PublicUser>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: PUBLIC_USER_SELECT
    });
    return new Map(users.map((u) => [u.id, publicUser(u)]));
  }

  async listChats(
    sandbox: WorkspaceSandbox,
    sessionId: string
  ): Promise<{ chats: AgentChatDto[] }> {
    const session = await this.prisma.sandboxConversation.findFirst({
      where: { id: sessionId, sandboxId: sandbox.id, slug: { not: null } }
    });
    if (!session) throw new NotFoundException('Session not found');
    const rows = await this.prisma.sandboxChat.findMany({
      where: { conversationId: session.id, archivedAt: null },
      orderBy: { createdAt: 'asc' }
    });
    const states = new Map<string, DaemonChatState>();
    if (rows.length && sandbox.status === 'running' && session.worktreePath) {
      const res = await this.daemon
        .tryCall<{ chats: DaemonChatState[] }>(
          refOf(sandbox),
          'chat.list',
          { cwd: session.worktreePath },
          10_000
        )
        .catch(() => null);
      for (const st of res?.chats ?? []) states.set(st.id, st);
    }
    const users = await this.creators(rows.map((r) => r.createdById));
    return {
      chats: rows.map((row) => {
        const st = states.get(row.id);
        return {
          id: row.id,
          sessionId: row.conversationId,
          agent: row.agent,
          title: st?.title || row.title,
          createdAt: row.createdAt,
          createdBy: row.createdById ? (users.get(row.createdById) ?? null) : null,
          activity: st?.activity ?? 'idle',
          lastSeq: st?.lastSeq ?? 0,
          configOptions: st?.configOptions ?? null,
          running: !!st?.running,
          queued: st?.queued ?? 0
        };
      })
    };
  }

  async createChat(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    actorUserId: string,
    body: {
      id?: unknown;
      agent?: unknown;
      title?: unknown;
      config?: unknown;
      prompt?: unknown;
    }
  ): Promise<AgentChatDto> {
    this.requireRunning(sandbox);
    const session = await this.sessionOf(sandbox.id, sessionId);
    const agent = typeof body.agent === 'string' ? body.agent : '';
    if (!AGENT_ID_RE.test(agent)) throw new BadRequestException('Unknown agent');
    const id = typeof body.id === 'string' && body.id ? body.id : newAgentChatId();
    if (!AGENT_CHAT_ID_RE.test(id)) throw new BadRequestException('Invalid chat id');
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE)
        : 'New chat';
    const config = this.configMap(body.config);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length > MAX_PROMPT_CHARS) throw new BadRequestException('prompt is too long');
    const existing = await this.prisma.sandboxChat.findUnique({ where: { id } });
    if (existing && (existing.sandboxId !== sandbox.id || existing.conversationId !== session.id)) {
      throw new ConflictException('That chat id is already in use');
    }
    if (!existing) {
      await this.prisma.sandboxChat.create({
        data: {
          id,
          sandboxId: sandbox.id,
          conversationId: session.id,
          agent,
          title,
          createdById: actorUserId
        }
      });
    }
    const author = await this.author(actorUserId);
    const promptId = newMessageId();
    if (prompt) this.recordAuthor(sandbox.id, session.id, id, promptId, actorUserId);
    const state = await this.daemon
      .call<DaemonChatState>(
        refOf(sandbox),
        'chat.create',
        {
          chatId: id,
          agent,
          cwd: session.worktreePath,
          title,
          ...(Object.keys(config).length ? { config } : {}),
          ...(prompt ? { prompt: { text: prompt, author, messageId: promptId } } : {})
        },
        150_000
      )
      .catch(wrap);
    return this.dto(id, session.id, agent, title, new Date(), author, state);
  }

  private dto(
    id: string,
    sessionId: string,
    agent: string,
    title: string,
    createdAt: Date,
    createdBy: PublicUser | null,
    state: DaemonChatState | null
  ): AgentChatDto {
    return {
      id,
      sessionId,
      agent,
      title: state?.title || title,
      createdAt,
      createdBy,
      activity: state?.activity ?? 'idle',
      lastSeq: state?.lastSeq ?? 0,
      configOptions: state?.configOptions ?? null,
      running: !!state?.running,
      queued: state?.queued ?? 0
    };
  }

  private configMap(raw: unknown): Record<string, string | boolean> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('config must be an object');
    }
    const out: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!CONFIG_ID_RE.test(key)) throw new BadRequestException(`Invalid config option ${key}`);
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new BadRequestException(`Config option ${key} must be a string or boolean`);
      }
      if (typeof value === 'string' && value.length > 200) {
        throw new BadRequestException(`Config option ${key} is too long`);
      }
      out[key] = value;
    }
    return out;
  }

  private recordAuthor(
    sandboxId: string,
    sessionId: string,
    chatId: string,
    messageId: string,
    userId: string
  ) {
    void this.prisma.sandboxPromptAuthor
      .create({
        data: { sandboxId, sessionKey: sessionId, opencodeSessionId: chatId, messageId, userId }
      })
      .catch(() => null);
  }

  private async author(userId: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT
    });
    return user ? publicUser(user) : null;
  }

  async prompt(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    actorUserId: string,
    body: { text?: unknown; messageId?: unknown; steer?: unknown }
  ): Promise<{ messageId: string; seq: number; queued: boolean }> {
    this.requireRunning(sandbox);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new BadRequestException('text is required');
    if (text.length > MAX_PROMPT_CHARS) throw new BadRequestException('text is too long');
    await this.chatRow(sandbox.id, sessionId, chatId);
    const messageId =
      typeof body.messageId === 'string' && /^msg_[A-Za-z0-9_-]{6,64}$/.test(body.messageId)
        ? body.messageId
        : newMessageId();
    const author = await this.author(actorUserId);
    this.recordAuthor(sandbox.id, sessionId, chatId, messageId, actorUserId);
    void this.sessions?.titleFromPrompt({ sandbox, sessionId, text }).catch(() => null);
    return this.daemon
      .call<{ messageId: string; seq: number; queued: boolean }>(
        refOf(sandbox),
        'chat.prompt',
        { chatId, text, messageId, author, steer: body.steer === true },
        30_000
      )
      .catch(wrap);
  }

  async cancel(sandbox: WorkspaceSandbox, sessionId: string, chatId: string, actorUserId: string) {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    const author = await this.author(actorUserId);
    return this.daemon.call(refOf(sandbox), 'chat.cancel', { chatId, author }, 15_000).catch(wrap);
  }

  async answer(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    actorUserId: string,
    body: { requestId?: unknown; optionId?: unknown; cancel?: unknown }
  ) {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!/^perm_[0-9_]{1,40}$/.test(requestId)) throw new BadRequestException('Invalid request id');
    const optionId = typeof body.optionId === 'string' ? body.optionId.slice(0, 200) : '';
    const author = await this.author(actorUserId);
    return this.daemon
      .call(
        refOf(sandbox),
        'chat.permission',
        { chatId, requestId, optionId, cancel: body.cancel === true || !optionId, author },
        15_000
      )
      .catch(wrap);
  }

  async setConfig(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    body: { configId?: unknown; value?: unknown }
  ) {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    const configId = typeof body.configId === 'string' ? body.configId : '';
    if (!CONFIG_ID_RE.test(configId)) throw new BadRequestException('Invalid config option');
    if (typeof body.value !== 'string' && typeof body.value !== 'boolean') {
      throw new BadRequestException('value must be a string or boolean');
    }
    return this.daemon
      .call(refOf(sandbox), 'chat.config', { chatId, configId, value: body.value }, 60_000)
      .catch(wrap);
  }

  async revert(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    actorUserId: string,
    body: { commit?: unknown }
  ) {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    const commit = typeof body.commit === 'string' ? body.commit : '';
    if (!COMMIT_RE.test(commit)) throw new BadRequestException('Invalid checkpoint');
    const author = await this.author(actorUserId);
    return this.daemon
      .call(refOf(sandbox), 'chat.revert', { chatId, commit, author }, 90_000)
      .catch(wrap);
  }

  async deleteChat(sandbox: WorkspaceSandbox, sessionId: string, chatId: string) {
    await this.chatRow(sandbox.id, sessionId, chatId);
    if (sandbox.status === 'running') {
      await this.daemon
        .tryCall(refOf(sandbox), 'chat.delete', { chatId }, 30_000)
        .catch((e) =>
          this.logger.warn(`chat ${chatId} delete on the machine failed: ${e?.message}`)
        );
    }
    await this.prisma.sandboxChat.delete({ where: { id: chatId } }).catch(() => null);
    return { ok: true };
  }

  async renameChat(sandbox: WorkspaceSandbox, sessionId: string, chatId: string, title: unknown) {
    await this.chatRow(sandbox.id, sessionId, chatId);
    if (typeof title !== 'string' || !title.trim())
      throw new BadRequestException('title is required');
    await this.prisma.sandboxChat.update({
      where: { id: chatId },
      data: { title: title.trim().slice(0, MAX_TITLE) }
    });
    return { ok: true };
  }

  async events(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    since: number
  ): Promise<{ events: DaemonEvent[]; lastSeq: number }> {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    return this.daemon
      .call<{ events: DaemonEvent[]; lastSeq: number }>(
        refOf(sandbox),
        'chat.events',
        { chatId, since: Math.max(0, since) },
        30_000
      )
      .catch(wrap);
  }

  async stream(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    chatId: string,
    since: number,
    send: (ev: DaemonEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    this.requireRunning(sandbox);
    await this.chatRow(sandbox.id, sessionId, chatId);
    const ref = refOf(sandbox);
    let last = Math.max(0, since);
    const buffered: DaemonEvent[] = [];
    let replaying = true;
    const onEvent = (sandboxId: string, ev: DaemonEvent) => {
      if (sandboxId !== sandbox.id || ev.chatId !== chatId) return;
      if (replaying) {
        buffered.push(ev);
        return;
      }
      if (ev.seq <= last) return;
      last = ev.seq;
      send(ev);
    };
    this.daemon.events.on('event', onEvent);
    signal.addEventListener('abort', () => {
      this.daemon.events.off('event', onEvent);
      this.daemon.unsubscribe(ref, chatId);
    });
    let replay: { events: DaemonEvent[]; lastSeq: number };
    try {
      replay = await this.daemon.subscribe(ref, chatId, last);
    } catch (e) {
      this.daemon.events.off('event', onEvent);
      wrap(e);
    }
    for (const ev of [...replay.events, ...buffered].sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= last) continue;
      last = ev.seq;
      send(ev);
    }
    replaying = false;
  }

  async activityByWorktree(
    sandbox: WorkspaceSandbox,
    worktrees: string[]
  ): Promise<Map<string, AgentActivity>> {
    const out = new Map<string, AgentActivity>();
    if (sandbox.status !== 'running' || worktrees.length === 0) return out;
    const res = await this.daemon
      .tryCall<{ chats: DaemonChatState[] }>(refOf(sandbox), 'chat.list', {}, 5000)
      .catch(() => null);
    const wanted = new Set(worktrees);
    for (const chat of res?.chats ?? []) {
      if (!wanted.has(chat.cwd)) continue;
      out.set(chat.cwd, mergeActivity(out.get(chat.cwd), chat.activity));
    }
    return out;
  }
}

export interface AcpTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  truncated: boolean;
  createdAt: string | null;
  author: PublicUser | null;
}

const MAX_TRANSCRIPT_TEXT = 20000;

function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

export function acpTranscript(events: DaemonEvent[], limit: number): AcpTranscriptMessage[] {
  const out: AcpTranscriptMessage[] = [];
  let current: AcpTranscriptMessage | null = null;
  let currentKey: string | null = null;
  for (const ev of events) {
    if (ev.kind === 'prompt') {
      const data = (ev.data ?? {}) as { messageId?: string; prompt?: unknown };
      const text = blockText(data.prompt).trim();
      current = null;
      currentKey = null;
      if (!text) continue;
      out.push({
        id: data.messageId || `seq_${ev.seq}`,
        role: 'user',
        text,
        truncated: false,
        createdAt: new Date(ev.ts).toISOString(),
        author: ev.author
          ? { id: ev.author.id, name: ev.author.name ?? '', avatarUrl: ev.author.avatarUrl ?? null }
          : null
      });
      continue;
    }
    if (ev.kind === 'turn.end' || ev.kind === 'turn.start') {
      current = null;
      currentKey = null;
      continue;
    }
    if (ev.kind !== 'update') continue;
    const update = (ev.data ?? {}) as {
      sessionUpdate?: string;
      messageId?: string;
      content?: { type?: string; text?: string };
    };
    if (update.sessionUpdate !== 'agent_message_chunk') {
      if (update.sessionUpdate === 'tool_call') {
        current = null;
        currentKey = null;
      }
      continue;
    }
    const chunk = update.content?.type === 'text' ? (update.content.text ?? '') : '';
    if (!chunk) continue;
    const key = update.messageId ?? null;
    if (!current || (key && key !== currentKey)) {
      current = {
        id: key ?? `seq_${ev.seq}`,
        role: 'assistant',
        text: '',
        truncated: false,
        createdAt: new Date(ev.ts).toISOString(),
        author: null
      };
      currentKey = key;
      out.push(current);
    }
    current.text += chunk;
  }
  for (const m of out) {
    m.text = m.text.trim();
    if (m.text.length > MAX_TRANSCRIPT_TEXT) {
      m.text = m.text.slice(0, MAX_TRANSCRIPT_TEXT);
      m.truncated = true;
    }
  }
  return out.filter((m) => m.text).slice(-limit);
}

export function newMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}
