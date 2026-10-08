import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable
} from '@nestjs/common';
import type { SandboxConversation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxWorkspaceService, type WorkspaceSandbox } from './sandbox-workspace.service';
import {
  PUBLIC_USER_SELECT,
  SandboxMembersService,
  publicUser,
  type PublicUser
} from './sandbox-members.service';
import { newOpencodeMessageId } from './sandbox-opencode-policy';
import { isWorktreePath } from './sandbox-session-commands';
import { SandboxNotRunningError } from './runners/sandbox-runner';

export const MAX_PROMPT_CHARS = 32768;
export const DEFAULT_TRANSCRIPT_LIMIT = 30;
export const MAX_TRANSCRIPT_LIMIT = 200;
const MAX_MESSAGE_CHARS = 20000;
const OPENCODE_TIMEOUT_MS = 15_000;
const CHAT_ID_RE = /^ses_[A-Za-z0-9]{1,60}$/;

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  truncated: boolean;
  createdAt: string | null;
  author: PublicUser | null;
}

export interface SessionTranscript {
  sessionId: string;
  chatId: string | null;
  title: string;
  messages: TranscriptMessage[];
}

export function transcriptLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_TRANSCRIPT_LIMIT;
  }
  return Math.min(parsed, MAX_TRANSCRIPT_LIMIT);
}

export function transcriptMessages(
  body: unknown,
  limit: number
): Omit<TranscriptMessage, 'author'>[] {
  if (!Array.isArray(body)) return [];
  const out: Omit<TranscriptMessage, 'author'>[] = [];
  for (const entry of body) {
    const info = (entry as { info?: any } | null)?.info;
    const parts = (entry as { parts?: unknown } | null)?.parts;
    if (!info || typeof info.id !== 'string') continue;
    if (info.role !== 'user' && info.role !== 'assistant') continue;
    const texts = Array.isArray(parts)
      ? parts
          .filter(
            (p: any) =>
              p && p.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored
          )
          .map((p: any) => (p.text as string).trim())
          .filter(Boolean)
      : [];
    if (texts.length === 0) continue;
    const joined = texts.join('\n\n');
    const created = Number(info.time?.created);
    out.push({
      id: info.id,
      role: info.role,
      text: joined.length > MAX_MESSAGE_CHARS ? joined.slice(0, MAX_MESSAGE_CHARS) : joined,
      truncated: joined.length > MAX_MESSAGE_CHARS,
      createdAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null
    });
  }
  return out.slice(-limit);
}

@Injectable()
export class SandboxAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly members: SandboxMembersService
  ) {}

  private async chatFor(sandbox: WorkspaceSandbox, session: SandboxConversation): Promise<string> {
    if (session.opencodeSessionId) {
      if (!CHAT_ID_RE.test(session.opencodeSessionId)) {
        throw new BadGatewayException('This session has an unexpected agent chat id');
      }
      return session.opencodeSessionId;
    }
    const res = await this.workspace.opencodeRequest(sandbox, 'POST', '/session', {
      directory: session.worktreePath,
      body: { title: session.title },
      timeoutMs: OPENCODE_TIMEOUT_MS
    });
    const id = (res.body as { id?: unknown } | null)?.id;
    if (res.status < 200 || res.status >= 300 || typeof id !== 'string' || !CHAT_ID_RE.test(id)) {
      throw new BadGatewayException('The agent in this sandbox could not start a chat');
    }
    const claimed = await this.prisma.sandboxConversation.updateMany({
      where: { id: session.id, opencodeSessionId: null },
      data: { opencodeSessionId: id }
    });
    if (claimed.count === 1) return id;
    const fresh = await this.workspace.sessionRow(sandbox.id, session.id);
    if (!fresh.opencodeSessionId || !CHAT_ID_RE.test(fresh.opencodeSessionId)) {
      throw new ConflictException('This session changed while the prompt was being sent');
    }
    return fresh.opencodeSessionId;
  }

  async prompt(
    sandbox: WorkspaceSandbox & { status: string },
    sessionId: string,
    userId: string,
    text: unknown
  ): Promise<{ messageId: string; chatId: string; sessionId: string }> {
    if (typeof text !== 'string' || !text.trim()) {
      throw new BadRequestException('text is required');
    }
    if (text.length > MAX_PROMPT_CHARS) throw new BadRequestException('text is too long');
    if (sandbox.status !== 'running') throw new SandboxNotRunningError();
    const session = await this.workspace.sessionRow(sandbox.id, sessionId);
    if (session.archivedAt) throw new BadRequestException('This session is archived');
    if (!isWorktreePath(session.worktreePath)) {
      throw new BadRequestException('This session has no worktree');
    }
    const chatId = await this.chatFor(sandbox, session);
    const messageId = newOpencodeMessageId();
    const recorded = await this.members.recordPrompt({
      sandboxId: sandbox.id,
      userId,
      chatId,
      messageId,
      directory: session.worktreePath
    });
    if (!recorded) throw new ConflictException('That message id is already in use');
    const res = await this.workspace.opencodeRequest(
      sandbox,
      'POST',
      `/session/${encodeURIComponent(chatId)}/prompt_async`,
      {
        directory: session.worktreePath,
        body: { messageID: messageId, parts: [{ type: 'text', text }] },
        timeoutMs: OPENCODE_TIMEOUT_MS
      }
    );
    if (res.status < 200 || res.status >= 300) {
      throw new BadGatewayException(`The agent did not accept the prompt (${res.status})`);
    }
    return { messageId, chatId, sessionId: session.id };
  }

  async transcript(
    sandbox: WorkspaceSandbox,
    sessionId: string,
    opts: { limit?: unknown } = {}
  ): Promise<SessionTranscript> {
    const session = await this.workspace.sessionRow(sandbox.id, sessionId);
    const chatId = session.opencodeSessionId;
    if (!chatId) return { sessionId: session.id, chatId: null, title: session.title, messages: [] };
    if (!CHAT_ID_RE.test(chatId)) {
      throw new BadGatewayException('This session has an unexpected agent chat id');
    }
    const limit = transcriptLimit(opts.limit);
    const query = new URLSearchParams({ limit: String(limit) });
    if (isWorktreePath(session.worktreePath)) query.set('directory', session.worktreePath);
    const res = await this.workspace.opencodeRequest(
      sandbox,
      'GET',
      `/session/${encodeURIComponent(chatId)}/message?${query.toString()}`,
      { timeoutMs: OPENCODE_TIMEOUT_MS }
    );
    if (res.status !== 200) {
      throw new BadGatewayException(`The agent transcript is unavailable (${res.status})`);
    }
    const messages = transcriptMessages(res.body, limit);
    const userIds = messages.filter((m) => m.role === 'user').map((m) => m.id);
    const authors = userIds.length
      ? await this.prisma.sandboxPromptAuthor.findMany({
          where: { sandboxId: sandbox.id, messageId: { in: userIds } },
          select: { messageId: true, user: { select: PUBLIC_USER_SELECT } }
        })
      : [];
    const byMessage = new Map(authors.map((a) => [a.messageId, publicUser(a.user)]));
    return {
      sessionId: session.id,
      chatId,
      title: session.title,
      messages: messages.map((m) => ({ ...m, author: byMessage.get(m.id) ?? null }))
    };
  }
}
