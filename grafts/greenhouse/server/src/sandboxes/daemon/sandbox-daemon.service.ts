import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { SandboxProbesService } from '../runners/sandbox-probes.service';
import { EventEmitter } from 'events';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { SandboxSecretsService } from '../runners/sandbox-secrets';
import {
  refOf,
  type ExecOptions,
  type ExecResult,
  type SandboxRef
} from '../runners/sandbox-runner';
import { SANDBOX_AGENTD_PORT } from '../sandbox-bootstrap';
import { DaemonConnection, DaemonRpcError, DaemonUnavailableError } from './daemon-connection';

const MISS_RETRY_MS = 30_000;
const RESUBSCRIBE_MS = 1000;
const EXEC_GRACE_MS = 5000;

export interface DaemonEvent {
  seq: number;
  ts: number;
  chatId: string;
  kind: string;
  author?: { id: string; name?: string; avatarUrl?: string } | null;
  data?: unknown;
}

export interface DaemonActivity {
  chatId: string;
  cwd: string;
  activity: 'idle' | 'working' | 'needs_input';
}

type Subscription = { count: number; lastSeq: number };

export function daemonUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/rpc';
  url.search = '';
  return url.toString();
}

@Injectable()
export class SandboxDaemonService implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxDaemonService.name);
  private readonly conns = new Map<string, Promise<DaemonConnection | null>>();
  private readonly live = new Map<string, DaemonConnection>();
  private readonly retryAt = new Map<string, number>();
  private readonly refs = new Map<string, SandboxRef>();
  private readonly subs = new Map<string, Map<string, Subscription>>();
  readonly events = new EventEmitter();
  private destroyed = false;

  constructor(
    private readonly registry: SandboxRunnerRegistry,
    private readonly secrets: SandboxSecretsService,
    @Optional() probes?: SandboxProbesService
  ) {
    this.events.setMaxListeners(0);
    registry.setExecRouter((ref, script, opts) => this.routeExec(ref, script, opts));
    probes?.setDaemonBusy(async (row) => {
      const res = await this.tryCall<{ busy: boolean }>(refOf(row), 'activity.busy', {}, 5000);
      return res ? !!res.busy : null;
    });
  }

  enabled(): boolean {
    return process.env.SANDBOX_DAEMON !== 'off';
  }

  onModuleDestroy() {
    this.destroyed = true;
    for (const conn of this.live.values()) conn.close();
    this.live.clear();
    this.conns.clear();
  }

  forget(sandboxId: string) {
    this.live.get(sandboxId)?.close();
    this.live.delete(sandboxId);
    this.conns.delete(sandboxId);
    this.retryAt.delete(sandboxId);
  }

  async connection(ref: SandboxRef): Promise<DaemonConnection | null> {
    if (!this.enabled() || this.destroyed) return null;
    this.refs.set(ref.id, ref);
    const open = this.live.get(ref.id);
    if (open && !open.closed) return open;
    const retry = this.retryAt.get(ref.id);
    if (retry && retry > Date.now()) return null;
    let pending = this.conns.get(ref.id);
    if (!pending) {
      pending = this.dial(ref).finally(() => this.conns.delete(ref.id));
      this.conns.set(ref.id, pending);
    }
    return pending;
  }

  private async dial(ref: SandboxRef): Promise<DaemonConnection | null> {
    try {
      const target = await this.registry.for(ref).httpTarget(ref, SANDBOX_AGENTD_PORT);
      if (target.kind !== 'url') {
        this.retryAt.set(ref.id, Date.now() + MISS_RETRY_MS * 10);
        return null;
      }
      const token = await this.secrets.boxSecret('agentd-token', ref.id);
      if (!token) {
        this.retryAt.set(ref.id, Date.now() + MISS_RETRY_MS * 10);
        return null;
      }
      const conn = new DaemonConnection(daemonUrl(target.baseUrl), token);
      await conn.open();
      const info = await conn.call<{ version?: string }>('initialize', {}, 5000);
      conn.version = info?.version ?? null;
      conn.on('notification', (method: string, params: any) =>
        this.onNotification(ref.id, method, params)
      );
      conn.on('close', () => {
        if (this.live.get(ref.id) === conn) this.live.delete(ref.id);
        this.events.emit('disconnect', ref.id);
        if (this.subs.get(ref.id)?.size) {
          setTimeout(() => {
            void this.resubscribe(ref.id);
          }, RESUBSCRIBE_MS).unref?.();
        }
      });
      this.retryAt.delete(ref.id);
      this.live.set(ref.id, conn);
      this.events.emit('connect', ref.id);
      return conn;
    } catch (e: any) {
      this.retryAt.set(ref.id, Date.now() + MISS_RETRY_MS);
      this.logger.debug(`daemon unavailable for ${ref.id}: ${e?.message}`);
      return null;
    }
  }

  private onNotification(sandboxId: string, method: string, params: any) {
    if (method === 'chat.event' && params && typeof params.chatId === 'string') {
      const sub = this.subs.get(sandboxId)?.get(params.chatId);
      if (sub && typeof params.seq === 'number') {
        if (params.seq <= sub.lastSeq) return;
        sub.lastSeq = params.seq;
      }
      this.events.emit('event', sandboxId, params as DaemonEvent);
    } else if (method === 'chat.activity' && params) {
      this.events.emit('activity', sandboxId, params as DaemonActivity);
    } else if (method === 'agent.catalog') {
      this.events.emit('catalog', sandboxId, params);
    }
  }

  async available(ref: SandboxRef): Promise<boolean> {
    return (await this.connection(ref)) !== null;
  }

  async call<T>(ref: SandboxRef, method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const conn = await this.connection(ref);
    if (!conn) throw new DaemonUnavailableError('The machine daemon is not reachable');
    return conn.call<T>(method, params, timeoutMs);
  }

  async tryCall<T>(
    ref: SandboxRef,
    method: string,
    params: unknown,
    timeoutMs = 30_000
  ): Promise<T | null> {
    const conn = await this.connection(ref);
    if (!conn) return null;
    try {
      return await conn.call<T>(method, params, timeoutMs);
    } catch (e) {
      if (e instanceof DaemonUnavailableError) return null;
      throw e;
    }
  }

  async routeExec(ref: SandboxRef, script: string, opts: ExecOptions): Promise<ExecResult | null> {
    const conn = await this.connection(ref);
    if (!conn) return null;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    try {
      const res = await conn.call<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        ok: boolean;
      }>(
        'exec.script',
        {
          script,
          timeoutMs,
          ...(opts.stdin ? { stdin: opts.stdin.toString('base64') } : {})
        },
        timeoutMs + EXEC_GRACE_MS
      );
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, ok: res.ok };
    } catch (e: any) {
      if (e instanceof DaemonUnavailableError) return null;
      if (e instanceof DaemonRpcError && /timed out/.test(e.message)) {
        throw new Error('sandbox command timed out');
      }
      throw e;
    }
  }

  async subscribe(
    ref: SandboxRef,
    chatId: string,
    since: number
  ): Promise<{ events: DaemonEvent[]; lastSeq: number }> {
    let chats = this.subs.get(ref.id);
    if (!chats) {
      chats = new Map();
      this.subs.set(ref.id, chats);
    }
    const sub = chats.get(chatId);
    if (sub) sub.count += 1;
    else chats.set(chatId, { count: 1, lastSeq: since });
    try {
      const res = await this.call<{ events: DaemonEvent[]; lastSeq: number }>(
        ref,
        'chat.subscribe',
        { chatId, since },
        30_000
      );
      const current = chats.get(chatId);
      if (current && res.lastSeq > current.lastSeq) current.lastSeq = res.lastSeq;
      return { events: res.events ?? [], lastSeq: res.lastSeq ?? since };
    } catch (e) {
      this.unsubscribe(ref, chatId);
      throw e;
    }
  }

  unsubscribe(ref: SandboxRef, chatId: string) {
    const chats = this.subs.get(ref.id);
    const sub = chats?.get(chatId);
    if (!chats || !sub) return;
    sub.count -= 1;
    if (sub.count > 0) return;
    chats.delete(chatId);
    if (chats.size === 0) this.subs.delete(ref.id);
    void this.tryCall(ref, 'chat.unsubscribe', { chatId }, 5000).catch(() => null);
  }

  private async resubscribe(sandboxId: string) {
    const chats = this.subs.get(sandboxId);
    const ref = this.refs.get(sandboxId);
    if (!chats?.size || !ref || this.destroyed) return;
    this.retryAt.delete(sandboxId);
    const conn = await this.connection(ref);
    if (!conn) {
      setTimeout(() => {
        void this.resubscribe(sandboxId);
      }, MISS_RETRY_MS).unref?.();
      return;
    }
    for (const [chatId, sub] of chats) {
      try {
        const res = await conn.call<{ events: DaemonEvent[]; lastSeq: number }>(
          'chat.subscribe',
          { chatId, since: sub.lastSeq },
          30_000
        );
        for (const ev of res.events ?? []) {
          if (ev.seq <= sub.lastSeq) continue;
          sub.lastSeq = ev.seq;
          this.events.emit('event', sandboxId, ev);
        }
      } catch (e: any) {
        this.logger.warn(`resubscribe ${chatId} failed: ${e?.message}`);
      }
    }
  }
}
