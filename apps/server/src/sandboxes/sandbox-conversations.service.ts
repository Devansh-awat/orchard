import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SandboxConversation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxWorkspaceService, WorkspaceSandbox } from './sandbox-workspace.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { refOf } from './runners/sandbox-runner';

const MAX_HISTORY_BYTES = 2_000_000;

export interface ConversationDto {
  id: string;
  title: string;
  repo: string | null;
  hasSession: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toConversationDto(row: SandboxConversation): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    repo: row.repo,
    hasSession: !!row.claudeSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

@Injectable()
export class SandboxConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly workspace: SandboxWorkspaceService
  ) {}

  async list(sandboxId: string): Promise<ConversationDto[]> {
    const rows = await this.prisma.sandboxConversation.findMany({
      where: { sandboxId },
      orderBy: { createdAt: 'asc' }
    });
    return rows.map(toConversationDto);
  }

  async create(
    sandbox: { id: string; repoUrl: string | null },
    body: { title?: string; repo?: string | null }
  ): Promise<ConversationDto> {
    const title = (body.title || 'New conversation').trim().slice(0, 120);
    const repo = body.repo ? this.validateRepo(body.repo) : null;
    const row = await this.prisma.sandboxConversation.create({
      data: { sandboxId: sandbox.id, title, repo }
    });
    return toConversationDto(row);
  }

  private validateRepo(repo: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || repo.includes('..')) {
      throw new BadRequestException('Invalid repo name');
    }
    return repo;
  }

  async getOwned(sandboxId: string, conversationId: string): Promise<SandboxConversation> {
    const row = await this.prisma.sandboxConversation.findUnique({
      where: { id: conversationId }
    });
    if (!row || row.sandboxId !== sandboxId) {
      throw new NotFoundException('Conversation not found');
    }
    return row;
  }

  async update(
    sandboxId: string,
    conversationId: string,
    body: { title?: string; repo?: string | null }
  ): Promise<ConversationDto> {
    const row = await this.getOwned(sandboxId, conversationId);
    const data: { title?: string; repo?: string | null } = {};
    if (body.title !== undefined) {
      const title = body.title.trim().slice(0, 120);
      if (!title) throw new BadRequestException('Title must not be empty');
      data.title = title;
    }
    if (body.repo !== undefined) {
      if (row.claudeSessionId) {
        throw new BadRequestException(
          'This conversation already has a session; its working directory cannot change'
        );
      }
      data.repo = body.repo ? this.validateRepo(body.repo) : null;
    }
    const updated = await this.prisma.sandboxConversation.update({
      where: { id: row.id },
      data
    });
    return toConversationDto(updated);
  }

  async remove(sandboxId: string, conversationId: string): Promise<void> {
    const row = await this.getOwned(sandboxId, conversationId);
    await this.prisma.sandboxConversation.delete({ where: { id: row.id } });
  }

  async history(
    sandbox: WorkspaceSandbox,
    conversationId: string
  ): Promise<{ events: unknown[]; truncated: boolean }> {
    const row = await this.getOwned(sandbox.id, conversationId);
    if (!row.claudeSessionId) return { events: [], truncated: false };
    if (sandbox.status !== 'running') return { events: [], truncated: false };
    const workdir = this.workspace.resolveWorkdir(sandbox, row.repo || undefined);
    const projectDir = workdir.replace(/[/.]/g, '-');
    const sessionId = row.claudeSessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const path = `/persist/home/.claude/projects/${projectDir}/${sessionId}.jsonl`;
    let content = '';
    let truncated = false;
    try {
      const result = await this.registry.for(sandbox).readFile(refOf(sandbox), path, {
        maxBytes: MAX_HISTORY_BYTES,
        fromEnd: true,
        asUser: 'dev'
      });
      if (!result) return { events: [], truncated: false };
      content = result.content.toString('utf8');
      truncated = result.truncated;
    } catch {
      return { events: [], truncated: false };
    }
    const events: unknown[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'user' || event.type === 'assistant') events.push(event);
      } catch {
        continue;
      }
    }
    return { events, truncated };
  }
}
