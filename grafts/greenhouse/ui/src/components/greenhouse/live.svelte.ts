import { SvelteMap } from 'svelte/reactivity';
import type { GhSession, LiveComment, LiveView, PersonRef, RosterUser } from './types';

export type LiveFrame = Record<string, unknown> & { t: string };

export interface LiveSocket {
  send(frame: LiveFrame): void;
  close(): void;
}

export interface LiveHandlers {
  open(): void;
  frame(frame: LiveFrame): void;
  close(code: number, opened: boolean): void;
}

export interface LiveTransport {
  connect(url: string, handlers: LiveHandlers): LiveSocket;
}

export const wsTransport: LiveTransport = {
  connect(url, handlers) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}${url}`);
    let opened = false;
    socket.onopen = () => {
      opened = true;
      handlers.open();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const frame = JSON.parse(event.data) as LiveFrame;
        if (frame && typeof frame.t === 'string') handlers.frame(frame);
      } catch {
        return;
      }
    };
    socket.onclose = (event) => handlers.close(event.code, opened);
    return {
      send(frame) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      },
      close() {
        socket.onclose = null;
        socket.close(1000);
      }
    };
  }
};

export type LiveState = 'idle' | 'connecting' | 'open' | 'retrying' | 'unavailable';

export interface LiveRoomSink {
  connect(): void;
  disconnect(): void;
  receive(frame: LiveFrame): void;
}

export interface LiveDraft {
  user: PersonRef;
  chatId: string;
  text: string;
  at: number;
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const UNAVAILABLE_RETRY_MS = 60_000;
const DRAFT_INTERVAL_MS = 100;
const PING_MS = 25_000;
const DRAFT_TTL_MS = 15_000;

export class LiveClient {
  readonly sandboxId: string;
  state = $state<LiveState>('idle');
  sid = $state<string | null>(null);
  roster = $state.raw<RosterUser[]>([]);
  readonly drafts = new SvelteMap<string, LiveDraft>();
  comments = $state.raw<LiveComment[]>([]);
  readonly promptAuthors = new SvelteMap<string, PersonRef>();
  readonly answerAuthors = new SvelteMap<string, PersonRef>();
  following = $state<string | null>(null);
  selfId = $state<string | null>(null);
  kicked = $state<string | null>(null);

  onSession: ((session: GhSession) => void) | null = null;
  onPrompt: ((user: PersonRef, chatId: string, messageId: string) => void) | null = null;
  onFollowView: ((user: RosterUser) => void) | null = null;

  readonly others = $derived(this.roster.filter((u) => u.id !== this.selfId));
  readonly followed = $derived(
    this.following ? (this.roster.find((u) => u.id === this.following) ?? null) : null
  );

  #transport: LiveTransport;
  #socket: LiveSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #draftTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingDraft: { chatId: string; text: string } | null = null;
  #lastDraftAt = 0;
  #view: LiveView | null = null;
  #closed = false;
  readonly #rooms = new Map<string, LiveRoomSink>();

  constructor(sandboxId: string, transport: LiveTransport = wsTransport) {
    this.sandboxId = sandboxId;
    this.#transport = transport;
  }

  join(sid: string | null) {
    if (sid === this.sid && this.#socket) return;
    this.sid = sid;
    this.roster = [];
    this.drafts.clear();
    this.comments = [];
    this.promptAuthors.clear();
    this.answerAuthors.clear();
    this.following = null;
    this.#disconnect();
    if (!sid || this.#closed) return;
    this.#attempt = 0;
    this.#connect();
  }

  #connect() {
    const sid = this.sid;
    if (!sid || this.#closed) return;
    this.state = this.#attempt === 0 ? 'connecting' : 'retrying';
    const url = `/apiv1/sandboxes/${encodeURIComponent(this.sandboxId)}/live?sid=${encodeURIComponent(sid)}`;
    const socket = this.#transport.connect(url, {
      open: () => {
        if (this.#socket !== socket) return;
        this.state = 'open';
        this.#attempt = 0;
        socket.send({ t: 'hello', sid, ...(this.#view ? { view: this.#view } : {}) });
        this.#startPing();
        for (const sink of [...this.#rooms.values()]) sink.connect();
      },
      frame: (frame) => {
        if (this.#socket !== socket) return;
        this.#onFrame(frame);
      },
      close: (code, opened) => {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#stopPing();
        this.#roomsDown();
        if (this.#closed) return;
        if (code === 4401 || code === 4403) {
          this.state = 'unavailable';
          this.kicked = code === 4403 ? 'You no longer have access to this machine' : null;
          return;
        }
        if (!opened && (code === 4404 || code === 1006) && this.#attempt >= 2) {
          this.state = 'unavailable';
          this.#schedule(UNAVAILABLE_RETRY_MS);
          return;
        }
        this.state = 'retrying';
        this.#schedule(BACKOFF[Math.min(this.#attempt, BACKOFF.length - 1)]);
      }
    });
    this.#socket = socket;
  }

  #schedule(ms: number) {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#attempt += 1;
      this.#connect();
    }, ms);
  }

  #startPing() {
    this.#stopPing();
    this.#pingTimer = setInterval(() => this.#socket?.send({ t: 'ping' }), PING_MS);
  }

  #stopPing() {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #disconnect() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#stopPing();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.state = 'idle';
    this.#roomsDown();
  }

  #roomsDown() {
    for (const sink of [...this.#rooms.values()]) sink.disconnect();
  }

  attachRoom(room: string, sink: LiveRoomSink): () => void {
    this.#rooms.set(room, sink);
    if (this.#socket && this.state === 'open') sink.connect();
    return () => {
      if (this.#rooms.get(room) === sink) this.#rooms.delete(room);
    };
  }

  sendRoom(frame: LiveFrame): boolean {
    const socket = this.#socket;
    if (!socket || this.state !== 'open') return false;
    socket.send(frame);
    return true;
  }

  #onFrame(frame: LiveFrame) {
    if (frame.t.startsWith('yjs') && typeof frame.room === 'string') {
      this.#rooms.get(frame.room)?.receive(frame);
      return;
    }
    switch (frame.t) {
      case 'roster': {
        if (frame.sid && frame.sid !== this.sid) return;
        this.roster = Array.isArray(frame.users) ? (frame.users as RosterUser[]) : [];
        for (const id of [...this.drafts.keys()]) {
          if (!this.roster.some((u) => u.id === id)) this.drafts.delete(id);
        }
        if (this.following && !this.roster.some((u) => u.id === this.following)) {
          this.following = null;
        }
        return;
      }
      case 'presence': {
        const user = frame.user as RosterUser | undefined;
        if (!user?.id) return;
        const view = (frame.view as LiveView | null) ?? null;
        const known = this.roster.some((u) => u.id === user.id);
        const next = { ...user, view };
        this.roster = known
          ? this.roster.map((u) => (u.id === user.id ? { ...u, ...next } : u))
          : [...this.roster, next];
        if (this.following === user.id) {
          const followed = this.roster.find((u) => u.id === user.id);
          if (followed) this.onFollowView?.(followed);
        }
        return;
      }
      case 'draft': {
        const user = frame.user as PersonRef | undefined;
        if (!user?.id || user.id === this.selfId) return;
        const text = String(frame.text ?? '');
        if (!text.trim()) this.drafts.delete(user.id);
        else
          this.drafts.set(user.id, {
            user,
            chatId: String(frame.chatId ?? ''),
            text,
            at: Date.now()
          });
        return;
      }
      case 'prompt': {
        const user = frame.user as PersonRef | undefined;
        const messageId = String(frame.messageId ?? '');
        if (!user?.id || !messageId) return;
        this.promptAuthors.set(messageId, user);
        this.drafts.delete(user.id);
        this.onPrompt?.(user, String(frame.chatId ?? ''), messageId);
        return;
      }
      case 'answer': {
        const user = frame.user as PersonRef | undefined;
        const requestId = String(frame.requestId ?? '');
        if (!user?.id || !requestId || this.answerAuthors.has(requestId)) return;
        this.answerAuthors.set(requestId, user);
        return;
      }
      case 'comment': {
        const comment = frame.comment as LiveComment | undefined;
        if (!comment?.id || this.comments.some((c) => c.id === comment.id)) return;
        this.comments = [...this.comments, comment];
        return;
      }
      case 'session': {
        const session = frame.session as GhSession | undefined;
        if (session?.id) this.onSession?.(session);
        return;
      }
      case 'kicked': {
        this.kicked = String(frame.reason ?? 'Removed from this machine');
        this.#closed = true;
        this.#disconnect();
        this.state = 'unavailable';
        return;
      }
      default:
        return;
    }
  }

  draftsFor(chatId: string | null): LiveDraft[] {
    const now = Date.now();
    return [...this.drafts.values()].filter(
      (d) => (!chatId || !d.chatId || d.chatId === chatId) && now - d.at < DRAFT_TTL_MS
    );
  }

  commentsFor(chatId: string | null): LiveComment[] {
    return chatId ? this.comments.filter((c) => !c.chatId || c.chatId === chatId) : this.comments;
  }

  seedComments(comments: LiveComment[]) {
    const known = new Set(this.comments.map((c) => c.id));
    const merged = [...this.comments, ...comments.filter((c) => !known.has(c.id))];
    merged.sort((a, b) => Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)));
    this.comments = merged;
  }

  seedAuthors(authors: Record<string, PersonRef>) {
    for (const [id, user] of Object.entries(authors)) this.promptAuthors.set(id, user);
  }

  addLocalComment(comment: LiveComment) {
    if (this.comments.some((c) => c.id === comment.id)) return;
    this.comments = [...this.comments, comment];
  }

  presence(view: LiveView) {
    this.#view = view;
    const sid = this.sid;
    if (sid) this.#socket?.send({ t: 'presence', sid, view });
  }

  draft(chatId: string, text: string) {
    this.#pendingDraft = { chatId, text };
    const wait = DRAFT_INTERVAL_MS - (Date.now() - this.#lastDraftAt);
    if (wait <= 0) {
      this.#flushDraft();
      return;
    }
    if (!this.#draftTimer) this.#draftTimer = setTimeout(() => this.#flushDraft(), wait);
  }

  #flushDraft() {
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#draftTimer = null;
    const pending = this.#pendingDraft;
    const sid = this.sid;
    this.#pendingDraft = null;
    if (!pending || !sid) return;
    this.#lastDraftAt = Date.now();
    this.#socket?.send({ t: 'draft', sid, chatId: pending.chatId, text: pending.text });
  }

  comment(chatId: string, body: string): boolean {
    const sid = this.sid;
    if (!sid || !this.#socket || this.state !== 'open') return false;
    this.#socket.send({ t: 'comment', sid, chatId, body });
    return true;
  }

  follow(userId: string | null) {
    this.following = userId;
    this.#socket?.send({ t: 'follow', target: userId });
    if (userId) {
      const user = this.roster.find((u) => u.id === userId);
      if (user) this.onFollowView?.(user);
    }
  }

  close() {
    this.#closed = true;
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#disconnect();
  }
}
