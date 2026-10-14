import { apiFetch } from '../../../host/stores';
import { AcpReducer, pickOption, type AcpConfigOption, type AcpEvent } from './acp-reducer';
import type { PermissionReply } from './pending';
import type { SessionThread } from './session-store.svelte';

export const ACP_CHAT_RE = /^acp_[0-9a-f]{24}$/;

export function isAcpChat(id: string | null | undefined): boolean {
  return !!id && ACP_CHAT_RE.test(id);
}

const RECONNECT_MS = [500, 1000, 2000, 4000, 8000];

export type AcpChatInfo = {
  id: string;
  sessionId: string;
  agent: string;
  title: string;
  cwd: string | null;
  createdAt: number;
};

async function failure(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const message = body && typeof body.message === 'string' ? body.message : fallback;
  return new Error(message);
}

export function newAcpMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `msg_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class AcpChat {
  readonly info: AcpChatInfo;
  readonly thread: SessionThread;
  readonly reducer: AcpReducer;
  connected = $state(false);
  failed = $state<string | null>(null);
  configOptions = $state.raw<AcpConfigOption[]>([]);
  title = $state('');
  version = $state(0);

  #sandboxId: string;
  #stream: AbortController | null = null;
  #attempt = 0;
  #closed = false;
  #onChange: (chat: AcpChat) => void;

  constructor(
    sandboxId: string,
    info: AcpChatInfo,
    thread: SessionThread,
    onChange: (chat: AcpChat) => void
  ) {
    this.#sandboxId = sandboxId;
    this.info = info;
    this.thread = thread;
    this.title = info.title;
    this.reducer = new AcpReducer(info.id, thread, info.cwd);
    this.#onChange = onChange;
  }

  get base(): string {
    return `/apiv1/sandboxes/${encodeURIComponent(this.#sandboxId)}/sessions/${encodeURIComponent(this.info.sessionId)}/agent-chats/${encodeURIComponent(this.info.id)}`;
  }

  connect() {
    if (this.#stream || this.#closed) return;
    this.thread.loading = this.reducer.lastSeq === 0;
    const controller = new AbortController();
    this.#stream = controller;
    void this.#loop(controller.signal);
  }

  pause() {
    this.#stream?.abort();
    this.#stream = null;
    this.connected = false;
  }

  close() {
    this.#closed = true;
    this.pause();
  }

  async #loop(signal: AbortSignal) {
    for (;;) {
      try {
        const res = await apiFetch(`${this.base}/stream?since=${this.reducer.lastSeq}`, {
          signal,
          headers: { Accept: 'text/event-stream' }
        });
        if (res.status === 404) {
          this.failed = 'This chat no longer exists';
          this.thread.loading = false;
          return;
        }
        if (!res.ok || !res.body) throw new Error('stream unavailable');
        this.connected = true;
        this.failed = null;
        this.#attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          const batch: AcpEvent[] = [];
          let ready = false;
          while (boundary !== -1) {
            const frame = this.#parse(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (frame?.event === 'ready') ready = true;
            else if (frame?.event === 'error') this.failed = frame.data?.message ?? 'stream failed';
            else if (frame?.data && typeof frame.data.seq === 'number') batch.push(frame.data);
          }
          if (batch.length) this.apply(batch);
          if (ready) {
            this.thread.loading = false;
            this.thread.loaded = true;
            this.#emit();
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      this.connected = false;
      if (signal.aborted || this.#closed) return;
      const wait = RECONNECT_MS[Math.min(this.#attempt, RECONNECT_MS.length - 1)];
      this.#attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (signal.aborted || this.#closed) return;
    }
  }

  #parse(frame: string): { event: string; data: any } | null {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return event === 'message' ? null : { event, data: null };
    try {
      return { event, data: JSON.parse(data.join('\n')) };
    } catch {
      return null;
    }
  }

  apply(events: AcpEvent[]) {
    let changed = false;
    for (const ev of events) changed = this.reducer.apply(ev) || changed;
    if (!changed) return;
    this.#emit();
  }

  #emit() {
    this.thread.busy = this.reducer.busy;
    this.configOptions = this.reducer.configOptions;
    if (this.reducer.title) this.title = this.reducer.title;
    this.version += 1;
    this.#onChange(this);
  }

  async prompt(text: string, messageId: string = newAcpMessageId()): Promise<void> {
    const res = await apiFetch(`${this.base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, messageId })
    });
    if (!res.ok) throw await failure(res, 'The agent did not take the prompt');
    if (!this.#stream) this.connect();
  }

  async cancel(): Promise<void> {
    const res = await apiFetch(`${this.base}/cancel`, { method: 'POST' });
    if (!res.ok) throw await failure(res, 'Could not stop the agent');
  }

  async answer(requestId: string, reply: PermissionReply): Promise<void> {
    const pending = this.reducer.permissions.get(requestId);
    if (!pending) return;
    const option = pickOption(pending.options, reply);
    const res = await apiFetch(`${this.base}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        option ? { requestId, optionId: option.optionId } : { requestId, cancel: true }
      )
    });
    if (!res.ok) throw await failure(res, 'The agent did not take the answer');
  }

  async setConfig(configId: string, value: string | boolean): Promise<void> {
    const res = await apiFetch(`${this.base}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId, value })
    });
    if (!res.ok) throw await failure(res, 'Could not change that setting');
  }

  canRevert(messageId: string): boolean {
    return this.reducer.checkpoints.has(messageId) && !this.reducer.busy;
  }

  async revert(messageId: string): Promise<void> {
    const commit = this.reducer.checkpoints.get(messageId);
    if (!commit) throw new Error('There is no checkpoint for that message');
    const res = await apiFetch(`${this.base}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit })
    });
    if (!res.ok) throw await failure(res, 'Could not restore the files');
  }
}
