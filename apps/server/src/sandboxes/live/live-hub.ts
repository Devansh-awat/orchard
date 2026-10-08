import { randomUUID } from 'crypto';
import type { SandboxRole } from '../sandbox-access.service';
import { rankSandboxRole } from '../sandbox-access.service';
import { LiveBackend, liveChannel, LIVE_CHANNEL_PREFIX } from './live-backend';
import {
  ClientFrame,
  LIMIT_CLASS,
  LIVE_MAX_ROOMS_PER_CONNECTION,
  LIVE_MESSAGE_ROLE,
  LimitClass,
  LiveView,
  TokenBucket,
  colorIndexFor,
  createLimiters,
  liveRoleAllows,
  parseClientFrame,
  parseRoom
} from './live-protocol';
import { YEnvelope, YRoomManager, YRoomSubscriber } from './yjs-rooms';

export const LIVE_MAX_CONNECTIONS_PER_USER = 16;
export const LIVE_MAX_CONNECTIONS_TOTAL = 4000;
export const KICK_CODE = 4403;

export const presenceKey = (sandboxId: string) => `sbx-presence:${sandboxId}`;

export interface LiveSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface LiveRoleResolution {
  role: SandboxRole | null;
}

export interface LiveHubDeps {
  backend: LiveBackend;
  rooms: YRoomManager | null;
  resolveRole(
    sandboxId: string,
    userId: string,
    orgScope: string | null
  ): Promise<SandboxRole | null>;
  validateSession(sessionId: string): Promise<boolean>;
  sessionBelongs(sandboxId: string, sid: string): Promise<boolean>;
  postComment(input: {
    sandboxId: string;
    userId: string;
    sid: string;
    chatId: string;
    body: string;
  }): Promise<unknown>;
  normalizePath(value: unknown): string | null;
  warn?(message: string): void;
  recheckMs?: number;
  presenceTtlMs?: number;
  now?(): number;
}

export interface LiveConnection {
  id: string;
  sandboxId: string;
  userId: string;
  sessionId: string | null;
  orgScope: string | null;
  user: LiveUser;
  color: number;
  role: SandboxRole;
  sid: string | null;
  view: LiveView | null;
  socket: LiveSocket;
  limiters: Record<LimitClass, TokenBucket>;
  lastLimitNotice: number;
  rooms: Set<string>;
  sids: Map<string, boolean>;
  presenceWrittenAt: number;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface PresenceEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  color: number;
  role: SandboxRole;
  sid: string | null;
  view: LiveView | null;
  at: number;
}

type HubEnvelope =
  | { k: 'frame'; sandboxId: string; frame: Record<string, unknown>; except?: string | null }
  | { k: 'roster'; sandboxId: string }
  | { k: 'acl'; sandboxId: string; userId?: string | null }
  | (YEnvelope & { sandboxId?: string });

export interface RosterUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: number;
  role: SandboxRole;
  sid: string | null;
  view: LiveView | null;
}

export class SandboxLiveHub {
  private readonly bySandbox = new Map<string, Map<string, LiveConnection>>();

  private readonly byId = new Map<string, LiveConnection>();

  private readonly unsubscribe: () => void;

  private readonly timer: ReturnType<typeof setInterval>;

  private readonly recheckMs: number;

  private readonly presenceTtlMs: number;

  private readonly now: () => number;

  private closed = false;

  private rooms: YRoomManager | null;

  constructor(private readonly deps: LiveHubDeps) {
    this.rooms = deps.rooms;
    this.recheckMs = deps.recheckMs ?? 15_000;
    this.presenceTtlMs = deps.presenceTtlMs ?? 45_000;
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.backend.onMessage((channel, message) => {
      if (!channel.startsWith(LIVE_CHANNEL_PREFIX)) return;
      this.onEnvelope(channel.slice(LIVE_CHANNEL_PREFIX.length), message).catch(() => {});
    });
    this.timer = setInterval(() => {
      this.recheckAll().catch(() => {});
    }, this.recheckMs);
    this.timer.unref?.();
  }

  get replicaId(): string {
    return this.deps.backend.replicaId;
  }

  setRooms(rooms: YRoomManager | null) {
    this.rooms = rooms;
  }

  private warn(message: string) {
    this.deps.warn?.(message);
  }

  connectionCount(sandboxId: string, userId: string): number {
    let n = 0;
    for (const conn of this.bySandbox.get(sandboxId)?.values() ?? []) {
      if (conn.userId === userId) n += 1;
    }
    return n;
  }

  canAccept(sandboxId: string, userId: string): boolean {
    if (this.byId.size >= LIVE_MAX_CONNECTIONS_TOTAL) return false;
    return this.connectionCount(sandboxId, userId) < LIVE_MAX_CONNECTIONS_PER_USER;
  }

  localConnections(sandboxId: string): LiveConnection[] {
    return [...(this.bySandbox.get(sandboxId)?.values() ?? [])];
  }

  attach(input: {
    sandboxId: string;
    userId: string;
    sessionId: string | null;
    orgScope: string | null;
    user: LiveUser;
    role: SandboxRole;
    sid: string | null;
    socket: LiveSocket;
  }): LiveConnection {
    const conn: LiveConnection = {
      id: randomUUID(),
      sandboxId: input.sandboxId,
      userId: input.userId,
      sessionId: input.sessionId,
      orgScope: input.orgScope,
      user: input.user,
      color: colorIndexFor(input.userId),
      role: input.role,
      sid: input.sid,
      view: null,
      socket: input.socket,
      limiters: createLimiters(this.now),
      lastLimitNotice: 0,
      rooms: new Set(),
      sids: new Map(),
      presenceWrittenAt: 0,
      presenceTimer: null,
      closed: false
    };
    let local = this.bySandbox.get(input.sandboxId);
    if (!local) {
      local = new Map();
      this.bySandbox.set(input.sandboxId, local);
    }
    local.set(conn.id, conn);
    this.byId.set(conn.id, conn);
    this.writePresence(conn)
      .then(() => this.publishRoster(conn.sandboxId))
      .catch(() => {});
    return conn;
  }

  async detach(conn: LiveConnection): Promise<void> {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.presenceTimer) clearTimeout(conn.presenceTimer);
    this.byId.delete(conn.id);
    const local = this.bySandbox.get(conn.sandboxId);
    local?.delete(conn.id);
    if (local && local.size === 0) this.bySandbox.delete(conn.sandboxId);
    await this.deps.backend
      .hdel(presenceKey(conn.sandboxId), `${this.replicaId}/${conn.id}`)
      .catch(() => {});
    await this.rooms?.connectionClosed(conn.id).catch(() => {});
    await this.publishRoster(conn.sandboxId);
  }

  send(conn: LiveConnection, frame: Record<string, unknown>): void {
    if (conn.closed || conn.socket.readyState !== 1) return;
    if ((conn.socket.bufferedAmount ?? 0) > 8 * 1024 * 1024) {
      conn.socket.close(1013, 'slow consumer');
      return;
    }
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {}
  }

  publicUser(conn: LiveConnection) {
    return {
      id: conn.user.id,
      name: conn.user.name,
      avatarUrl: conn.user.avatarUrl,
      color: conn.color,
      role: conn.role
    };
  }

  async broadcast(
    sandboxId: string,
    frame: Record<string, unknown>,
    exceptConnId: string | null = null
  ) {
    await this.publish(sandboxId, { k: 'frame', sandboxId, frame, except: exceptConnId });
  }

  async aclChanged(sandboxId: string, userId: string | null = null) {
    await this.publish(sandboxId, { k: 'acl', sandboxId, userId });
  }

  private async publish(sandboxId: string, envelope: HubEnvelope) {
    try {
      await this.deps.backend.publish(liveChannel(sandboxId), JSON.stringify(envelope));
    } catch (e: any) {
      this.warn(`live publish failed: ${e?.message}`);
    }
  }

  async publishY(sandboxId: string, envelope: YEnvelope) {
    await this.publish(sandboxId, envelope);
  }

  deliverLocal(connId: string, frame: Record<string, unknown>) {
    const conn = this.byId.get(connId);
    if (conn) this.send(conn, frame);
  }

  private async onEnvelope(sandboxId: string, raw: string) {
    let envelope: HubEnvelope;
    try {
      envelope = JSON.parse(raw) as HubEnvelope;
    } catch {
      return;
    }
    if (envelope.k === 'frame') {
      for (const conn of this.localConnections(sandboxId)) {
        if (envelope.except && envelope.except === `${this.replicaId}/${conn.id}`) continue;
        this.send(conn, envelope.frame);
      }
      return;
    }
    if (envelope.k === 'roster') {
      const users = await this.roster(sandboxId);
      for (const conn of this.localConnections(sandboxId)) {
        this.send(conn, { t: 'roster', sid: conn.sid, users });
      }
      return;
    }
    if (envelope.k === 'acl') {
      const targets = this.localConnections(sandboxId).filter(
        (c) => !envelope.userId || c.userId === envelope.userId
      );
      await Promise.all(targets.map((c) => this.recheck(c)));
      return;
    }
    if (this.rooms) await this.rooms.handleEnvelope(envelope as YEnvelope);
  }

  private presenceEntry(conn: LiveConnection): PresenceEntry {
    return {
      userId: conn.userId,
      name: conn.user.name,
      avatarUrl: conn.user.avatarUrl,
      color: conn.color,
      role: conn.role,
      sid: conn.sid,
      view: conn.view,
      at: this.now()
    };
  }

  private async writePresence(conn: LiveConnection): Promise<void> {
    if (conn.closed) return;
    conn.presenceWrittenAt = this.now();
    await this.deps.backend
      .hset(
        presenceKey(conn.sandboxId),
        `${this.replicaId}/${conn.id}`,
        JSON.stringify(this.presenceEntry(conn)),
        this.presenceTtlMs * 2
      )
      .catch((e) => this.warn(`presence write failed: ${e?.message}`));
  }

  private schedulePresenceWrite(conn: LiveConnection) {
    const since = this.now() - conn.presenceWrittenAt;
    if (since >= 2000) {
      this.writePresence(conn).catch(() => {});
      return;
    }
    if (conn.presenceTimer) return;
    conn.presenceTimer = setTimeout(() => {
      conn.presenceTimer = null;
      this.writePresence(conn).catch(() => {});
    }, 2000 - since);
    conn.presenceTimer.unref?.();
  }

  async presence(sandboxId: string): Promise<PresenceEntry[]> {
    const all = await this.deps.backend.hgetall(presenceKey(sandboxId)).catch(() => ({}));
    const cutoff = this.now() - this.presenceTtlMs;
    const out: PresenceEntry[] = [];
    for (const [field, value] of Object.entries(all)) {
      try {
        const entry = JSON.parse(value) as PresenceEntry;
        if (entry.at >= cutoff) out.push(entry);
        else this.deps.backend.hdel(presenceKey(sandboxId), field).catch(() => {});
      } catch {}
    }
    return out;
  }

  async connectedUserIds(sandboxId: string, sid: string | null = null): Promise<Set<string>> {
    const entries = await this.presence(sandboxId);
    return new Set(entries.filter((e) => !sid || e.sid === sid).map((e) => e.userId));
  }

  async roster(sandboxId: string): Promise<RosterUser[]> {
    const entries = await this.presence(sandboxId);
    const byUser = new Map<string, RosterUser & { at: number }>();
    for (const entry of entries) {
      const current = byUser.get(entry.userId);
      if (!current) {
        byUser.set(entry.userId, {
          id: entry.userId,
          name: entry.name,
          avatarUrl: entry.avatarUrl,
          color: entry.color,
          role: entry.role,
          sid: entry.sid,
          view: entry.view,
          at: entry.at
        });
        continue;
      }
      if (rankSandboxRole(entry.role) > rankSandboxRole(current.role)) current.role = entry.role;
      if (entry.at > current.at) {
        current.at = entry.at;
        current.sid = entry.sid;
        current.view = entry.view;
      }
    }
    return [...byUser.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ at: _at, ...user }) => user);
  }

  private async publishRoster(sandboxId: string) {
    await this.publish(sandboxId, { k: 'roster', sandboxId });
  }

  private notifyLimited(conn: LiveConnection, type: string) {
    const now = this.now();
    if (now - conn.lastLimitNotice < 1000) return;
    conn.lastLimitNotice = now;
    this.send(conn, { t: 'error', code: 'rate_limited', type });
  }

  private async sidOk(conn: LiveConnection, sid: string): Promise<boolean> {
    const cached = conn.sids.get(sid);
    if (cached !== undefined) return cached;
    const ok = await this.deps.sessionBelongs(conn.sandboxId, sid).catch(() => false);
    if (conn.sids.size > 256) conn.sids.clear();
    conn.sids.set(sid, ok);
    return ok;
  }

  subscriberOf(conn: LiveConnection): YRoomSubscriber {
    return {
      replica: this.replicaId,
      connId: conn.id,
      userId: conn.userId,
      role: conn.role,
      name: conn.user.name,
      color: conn.color
    };
  }

  async handleMessage(conn: LiveConnection, raw: string): Promise<void> {
    if (conn.closed) return;
    const parsed = parseClientFrame(raw);
    if ('error' in parsed) {
      this.send(conn, { t: 'error', code: parsed.error });
      return;
    }
    const frame = parsed.frame;
    if (!liveRoleAllows(conn.role, LIVE_MESSAGE_ROLE[frame.t])) {
      this.send(conn, { t: 'error', code: 'forbidden', type: frame.t });
      return;
    }
    if (!conn.limiters[LIMIT_CLASS[frame.t]].take()) {
      this.notifyLimited(conn, frame.t);
      return;
    }
    await this.dispatch(conn, frame);
  }

  private async dispatch(conn: LiveConnection, frame: ClientFrame): Promise<void> {
    switch (frame.t) {
      case 'ping':
        this.send(conn, { t: 'pong' });
        return;
      case 'hello':
      case 'presence': {
        if (frame.sid && !(await this.sidOk(conn, frame.sid))) {
          this.send(conn, { t: 'error', code: 'bad_sid' });
          return;
        }
        const sidChanged = frame.sid !== conn.sid;
        conn.sid = frame.sid;
        if (frame.view) conn.view = frame.view;
        if (frame.t === 'hello' || sidChanged) {
          await this.writePresence(conn);
          if (frame.t === 'hello') {
            this.send(conn, {
              t: 'roster',
              sid: conn.sid,
              users: await this.roster(conn.sandboxId)
            });
          }
          await this.publishRoster(conn.sandboxId);
          return;
        }
        this.schedulePresenceWrite(conn);
        await this.broadcast(
          conn.sandboxId,
          { t: 'presence', user: this.publicUser(conn), sid: conn.sid, view: conn.view },
          `${this.replicaId}/${conn.id}`
        );
        return;
      }
      case 'draft': {
        if (!(await this.sidOk(conn, frame.sid))) {
          this.send(conn, { t: 'error', code: 'bad_sid' });
          return;
        }
        await this.broadcast(
          conn.sandboxId,
          {
            t: 'draft',
            user: this.publicUser(conn),
            sid: frame.sid,
            chatId: frame.chatId,
            text: frame.text
          },
          `${this.replicaId}/${conn.id}`
        );
        return;
      }
      case 'comment': {
        if (!(await this.sidOk(conn, frame.sid))) {
          this.send(conn, { t: 'error', code: 'bad_sid' });
          return;
        }
        try {
          await this.deps.postComment({
            sandboxId: conn.sandboxId,
            userId: conn.userId,
            sid: frame.sid,
            chatId: frame.chatId,
            body: frame.body
          });
        } catch (e: any) {
          this.send(conn, {
            t: 'error',
            code: 'comment_failed',
            message: e?.message || 'Could not post that comment'
          });
        }
        return;
      }
      case 'follow':
        await this.broadcast(
          conn.sandboxId,
          { t: 'follow', user: this.publicUser(conn), target: frame.target },
          `${this.replicaId}/${conn.id}`
        );
        return;
      case 'yjs':
      case 'yjs-awareness':
      case 'yjs-save':
      case 'yjs-reload':
      case 'yjs-leave': {
        const rooms = this.rooms;
        if (!rooms) {
          this.send(conn, {
            t: 'yjs-error',
            room: frame.room,
            message: 'Collaborative editing is unavailable'
          });
          return;
        }
        const room = parseRoom(frame.room, this.deps.normalizePath);
        if (!room) {
          this.send(conn, { t: 'error', code: 'bad_room' });
          return;
        }
        if (!(await this.sidOk(conn, room.sid))) {
          this.send(conn, { t: 'error', code: 'bad_room' });
          return;
        }
        if (frame.t === 'yjs-leave') {
          conn.rooms.delete(frame.room);
        } else if (!conn.rooms.has(frame.room)) {
          if (conn.rooms.size >= LIVE_MAX_ROOMS_PER_CONNECTION) {
            this.send(conn, { t: 'error', code: 'too_many_rooms' });
            return;
          }
          if (!conn.limiters.room.take()) {
            this.send(conn, { t: 'error', code: 'rate_limited' });
            return;
          }
          conn.rooms.add(frame.room);
        }
        const yframe =
          frame.t === 'yjs'
            ? { t: frame.t, b64: frame.b64, gen: frame.gen }
            : frame.t === 'yjs-awareness'
              ? { t: frame.t, b64: frame.b64 }
              : { t: frame.t };
        await rooms.handleLocal(conn.sandboxId, frame.room, this.subscriberOf(conn), yframe);
        return;
      }
    }
  }

  kick(conn: LiveConnection, reason: string) {
    this.send(conn, { t: 'kicked', reason });
    try {
      conn.socket.close(KICK_CODE, reason.slice(0, 100));
    } catch {}
    this.detach(conn).catch(() => {});
  }

  async recheck(conn: LiveConnection): Promise<void> {
    if (conn.closed) return;
    try {
      if (conn.sessionId && !(await this.deps.validateSession(conn.sessionId))) {
        this.kick(conn, 'Your session ended');
        return;
      }
      const role = await this.deps.resolveRole(conn.sandboxId, conn.userId, conn.orgScope);
      if (conn.closed) return;
      if (!role) {
        this.kick(conn, 'Your access to this sandbox was removed');
        return;
      }
      if (role !== conn.role) {
        conn.role = role;
        this.send(conn, { t: 'role', role });
        await this.writePresence(conn);
        await this.rooms?.updateSubscriber(this.subscriberOf(conn)).catch(() => {});
        await this.publishRoster(conn.sandboxId);
        return;
      }
      if (this.now() - conn.presenceWrittenAt > this.recheckMs / 2) await this.writePresence(conn);
    } catch (e: any) {
      this.warn(`live recheck failed: ${e?.message}`);
    }
  }

  async recheckAll(): Promise<void> {
    if (this.closed) return;
    await Promise.all([...this.byId.values()].map((conn) => this.recheck(conn)));
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    for (const conn of [...this.byId.values()]) {
      try {
        conn.socket.close(1001, 'server shutting down');
      } catch {}
      await this.detach(conn);
    }
  }
}
