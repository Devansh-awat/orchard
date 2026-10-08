import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { SandboxWorkspaceService, WorkspaceSandbox } from './sandbox-workspace.service';
import { SandboxConversationsService } from './sandbox-conversations.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { ExecStream, refOf } from './runners/sandbox-runner';

const MAX_MESSAGE_LENGTH = 32768;
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

@Injectable()
export class SandboxChatService {
  private readonly logger = new Logger(SandboxChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly workspace: SandboxWorkspaceService,
    private readonly conversations: SandboxConversationsService
  ) {}

  async stream(
    sandbox: WorkspaceSandbox,
    message: string,
    opts: { conversationId?: string; repo?: string },
    res: Response
  ): Promise<void> {
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException('message must be a non-empty string');
    }
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Sandbox is not running; start it first');
    }
    const runner = this.registry.for(sandbox);
    const configError = runner.configError();
    if (configError) throw new BadRequestException(configError);
    const credential = await this.prisma.sandboxCredential.findUnique({
      where: { userId: sandbox.userId }
    });
    const claudeToken = credential?.claudeToken
      ? this.crypto.decrypt(credential.claudeToken).replace(/\s+/g, '')
      : null;
    if (!claudeToken) {
      throw new BadRequestException(
        'No Claude credentials configured; add a token in user settings first'
      );
    }
    let conversation = opts.conversationId
      ? await this.conversations.getOwned(sandbox.id, opts.conversationId)
      : await this.prisma.sandboxConversation.findFirst({
          where: { sandboxId: sandbox.id },
          orderBy: { updatedAt: 'desc' }
        });
    if (!conversation) {
      conversation = await this.prisma.sandboxConversation.create({
        data: {
          sandboxId: sandbox.id,
          title: 'New conversation',
          repo: opts.repo || null
        }
      });
    } else if (opts.repo && !conversation.claudeSessionId && conversation.repo !== opts.repo) {
      conversation = await this.prisma.sandboxConversation.update({
        where: { id: conversation.id },
        data: { repo: opts.repo }
      });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (payload: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const touch = () =>
      this.prisma.sandbox
        .update({ where: { id: sandbox.id }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
    touch();

    const workdir = this.workspace.resolveWorkdir(sandbox, conversation.repo || undefined);
    const resume = conversation.claudeSessionId
      ? ` --resume '${conversation.claudeSessionId.replace(/[^a-zA-Z0-9_-]/g, '')}'`
      : '';
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const command = [
      'su',
      '-l',
      'dev',
      '-c',
      `export CLAUDE_CODE_OAUTH_TOKEN="$(cat)"; cd ${q(workdir)} 2>/dev/null || cd /persist/home; claude -p --output-format stream-json --verbose --dangerously-skip-permissions${resume} -- ${q(message)} < /dev/null`
    ];

    let exec: ExecStream;
    try {
      exec = await runner.execStream(refOf(sandbox), command, {
        stdin: Buffer.from(claudeToken, 'utf8')
      });
    } catch (e: any) {
      this.logger.warn(`chat exec failed for sandbox ${sandbox.id}: ${e?.message}`);
      send({ type: 'error', detail: e?.message || 'failed to reach the sandbox' });
      res.end();
      return;
    }
    const { stdout, stderr } = exec;
    let stderrText = '';
    let sawSessionNotFound = false;
    let buffer = '';

    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.session_id && event.session_id !== conversation.claudeSessionId) {
            conversation.claudeSessionId = event.session_id;
            const autoTitle =
              conversation.title === 'New conversation'
                ? { title: message.trim().slice(0, 60) }
                : {};
            this.prisma.sandboxConversation
              .update({
                where: { id: conversation.id },
                data: { claudeSessionId: event.session_id, ...autoTitle }
              })
              .catch(() => {});
          }
          send(event);
        } catch {
          send({ type: 'raw', text: line });
        }
      }
    });
    stderr.on('data', (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString()).slice(-4000);
      if (/no conversation found/i.test(stderrText)) sawSessionNotFound = true;
    });

    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let touchTimer: ReturnType<typeof setInterval> | undefined;
    const finish = async (status: 'done' | 'error', detail?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(touchTimer);
      if (sawSessionNotFound) {
        await this.prisma.sandboxConversation
          .update({ where: { id: conversation.id }, data: { claudeSessionId: null } })
          .catch(() => {});
      }
      touch();
      send({ type: status, ...(detail ? { detail } : {}) });
      res.end();
    };

    timeout = setTimeout(() => {
      exec.kill();
      void finish('error', 'chat turn timed out');
    }, CHAT_TIMEOUT_MS);
    touchTimer = setInterval(touch, 60_000);

    res.on('close', () => {
      exec.kill();
      void finish('done');
    });

    void exec.done.then((result) => {
      if (result.ok) {
        void finish('done');
        return;
      }
      const detail = sawSessionNotFound
        ? 'previous chat session was not found; it has been reset, send your message again'
        : stderrText.trim().slice(-500) || result.message || 'claude exited with an error';
      void finish('error', detail);
    });
  }
}
