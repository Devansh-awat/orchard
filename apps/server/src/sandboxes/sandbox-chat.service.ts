import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { SandboxK8sService } from './sandbox-k8s.service';

const MAX_MESSAGE_LENGTH = 32768;
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

@Injectable()
export class SandboxChatService {
  private readonly logger = new Logger(SandboxChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly sandboxK8s: SandboxK8sService,
  ) {}

  private workdir(repoUrl: string | null): string {
    if (!repoUrl) return '/persist/home';
    const base = repoUrl.replace(/\.git$/, '').split('/').pop() || '';
    return base ? `/persist/home/${base}` : '/persist/home';
  }

  async stream(
    sandbox: {
      id: string;
      podName: string;
      repoUrl: string | null;
      chatSessionId: string | null;
      status: string;
    },
    message: string,
    res: Response,
  ): Promise<void> {
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException('message must be a non-empty string');
    }
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Sandbox is not running; start it first');
    }
    if (!this.kubernetes.kc) {
      throw new BadRequestException('Kubernetes is not configured');
    }
    const core = this.kubernetes.kc.makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod(
      this.sandboxK8s.namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandbox.id}`,
    );
    const pod = pods.body.items.find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      throw new BadRequestException('Sandbox pod is not running');
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

    const workdir = this.workdir(sandbox.repoUrl);
    const resume = sandbox.chatSessionId ? ` --resume '${sandbox.chatSessionId.replace(/[^a-zA-Z0-9_-]/g, '')}'` : '';
    const command = [
      'su',
      '-l',
      'dev',
      '-c',
      `cd '${workdir}' 2>/dev/null || cd /persist/home; claude -p --output-format stream-json --verbose --dangerously-skip-permissions${resume}`,
    ];

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
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
          if (event.session_id && event.session_id !== sandbox.chatSessionId) {
            sandbox.chatSessionId = event.session_id;
            this.prisma.sandbox
              .update({ where: { id: sandbox.id }, data: { chatSessionId: event.session_id } })
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

    const exec = new k8s.Exec(this.kubernetes.kc);
    let execWs: any = null;
    let finished = false;
    const finish = async (status: 'done' | 'error', detail?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(touchTimer);
      if (sawSessionNotFound) {
        await this.prisma.sandbox
          .update({ where: { id: sandbox.id }, data: { chatSessionId: null } })
          .catch(() => {});
      }
      touch();
      send({ type: status, ...(detail ? { detail } : {}) });
      res.end();
    };

    const timeout = setTimeout(() => {
      try {
        execWs?.close();
      } catch {}
      void finish('error', 'chat turn timed out');
    }, CHAT_TIMEOUT_MS);
    const touchTimer = setInterval(touch, 60_000);

    res.on('close', () => {
      try {
        execWs?.close();
      } catch {}
      void finish('done');
    });

    try {
      execWs = await exec.exec(
        this.sandboxK8s.namespace,
        pod.metadata.name,
        'sandbox',
        command,
        stdout,
        stderr,
        stdin,
        false,
        (status) => {
          if (status.status === 'Success') {
            void finish('done');
          } else {
            const detail = sawSessionNotFound
              ? 'previous chat session was not found; it has been reset, send your message again'
              : stderrText.trim().slice(-500) || status.message || 'claude exited with an error';
            void finish('error', detail);
          }
        },
      );
      stdin.end(message);
    } catch (e: any) {
      this.logger.warn(`chat exec failed for sandbox ${sandbox.id}: ${e?.message}`);
      void finish('error', e?.message || 'failed to reach the sandbox');
    }
  }
}
