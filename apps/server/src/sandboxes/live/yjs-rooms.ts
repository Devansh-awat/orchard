import { createHash, randomUUID } from 'crypto';
import type * as YModule from 'yjs' with { 'resolution-mode': 'import' };
import type * as SyncModule from 'y-protocols/sync' with { 'resolution-mode': 'import' };
import type * as AwarenessModule from 'y-protocols/awareness' with { 'resolution-mode': 'import' };
import type * as EncodingModule from 'lib0/encoding' with { 'resolution-mode': 'import' };
import type * as DecodingModule from 'lib0/decoding' with { 'resolution-mode': 'import' };
import type * as DiffModule from 'lib0/diff' with { 'resolution-mode': 'import' };
import type { SandboxRole } from '../sandbox-access.service';
import { canWrite } from './live-protocol';

let Y: typeof YModule;
let syncProtocol: typeof SyncModule;
let awarenessProtocol: typeof AwarenessModule;
let encoding: typeof EncodingModule;
let decoding: typeof DecodingModule;
let simpleDiffString: (typeof DiffModule)['simpleDiffString'];
let yjsLoading: Promise<void> | null = null;

export function loadYjs(): Promise<void> {
  yjsLoading ??= Promise.all([
    import('yjs'),
    import('y-protocols/sync'),
    import('y-protocols/awareness'),
    import('lib0/encoding'),
    import('lib0/decoding'),
    import('lib0/diff')
  ]).then(([y, sync, awareness, enc, dec, diff]) => {
    Y = y;
    syncProtocol = sync;
    awarenessProtocol = awareness;
    encoding = enc;
    decoding = dec;
    simpleDiffString = diff.simpleDiffString;
  });
  return yjsLoading;
}

export const YROOM_TEXT = 'content';
export const YROOM_MAX_FILE_BYTES = 512000;
export const YROOM_MAX_DOC_CHARS = 1_000_000;
export const YROOM_MAX_AWARENESS_CLIENTS = 4;
export const YROOM_MAX_AWARENESS_STATE = 8 * 1024;

export const yroomOwnerKey = (room: string) => `sbx-yroom:${room}`;

export class YRoomFileError extends Error {}

export function contentHash(content: string): string {
  return createHash('md5').update(Buffer.from(content, 'utf8')).digest('hex');
}

export interface YRoomFiles {
  read(sandboxId: string, sid: string, path: string): Promise<{ content: string; hash: string }>;
  stat(sandboxId: string, sid: string, path: string): Promise<string | null>;
  write(sandboxId: string, sid: string, path: string, content: string): Promise<string>;
}

export interface YRoomSubscriber {
  replica: string;
  connId: string;
  userId: string;
  role: SandboxRole;
  name: string;
  color: number;
}

export interface YClientFrame {
  t: 'yjs' | 'yjs-awareness' | 'yjs-save' | 'yjs-reload' | 'yjs-leave';
  b64?: string;
  gen?: string | null;
}

export type YEnvelope =
  | {
      k: 'y-in';
      owner: string;
      sandboxId: string;
      room: string;
      sub: YRoomSubscriber;
      frame: YClientFrame;
    }
  | { k: 'y-out'; replica: string; connId: string; frame: Record<string, unknown> }
  | { k: 'y-sub'; owner: string; room: string; sub: YRoomSubscriber }
  | { k: 'y-left'; owner: string; room: string; replica: string; connId: string };

export interface YRoomBackend {
  claim(key: string, value: string, ttlMs: number): Promise<string>;
  refresh(key: string, value: string, ttlMs: number): Promise<boolean>;
  release(key: string, value: string): Promise<void>;
}

export interface YRoomTransport {
  replicaId: string;
  deliverLocal(connId: string, frame: Record<string, unknown>): void;
  publish(sandboxId: string, envelope: YEnvelope): Promise<void>;
}

export interface YRoomTimings {
  saveDebounceMs: number;
  pollMs: number;
  emptyTtlMs: number;
  ownerTtlMs: number;
  ownerHeartbeatMs: number;
  subscriberTtlMs: number;
  ownerCacheMs: number;
}

export const DEFAULT_YROOM_TIMINGS: YRoomTimings = {
  saveDebounceMs: 2000,
  pollMs: 3000,
  emptyTtlMs: 60_000,
  ownerTtlMs: 15_000,
  ownerHeartbeatMs: 5_000,
  subscriberTtlMs: 30_000,
  ownerCacheMs: 2_000
};

interface RoomSub {
  sub: YRoomSubscriber;
  seen: number;
  clients: Set<number>;
}

interface OwnedRoom {
  room: string;
  sandboxId: string;
  sid: string;
  path: string;
  doc: YModule.Doc;
  awareness: AwarenessModule.Awareness;
  gen: string;
  subs: Map<string, RoomSub>;
  lastDisk: string;
  baseUpdate: Uint8Array;
  hash: string;
  dirty: boolean;
  version: number;
  saving: boolean;
  saveAgain: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  emptySince: number | null;
  polling: boolean;
  destroyed: boolean;
}

const subKeyOf = (sub: { replica: string; connId: string }) => `${sub.replica}/${sub.connId}`;

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function splitRoom(room: string): { sid: string; path: string } {
  const rest = room.slice(5);
  return { sid: rest.slice(0, 36), path: rest.slice(37) };
}

export class YRoomManager {
  private readonly rooms = new Map<string, OwnedRoom>();

  private readonly creating = new Map<string, Promise<OwnedRoom | null>>();

  private readonly owners = new Map<string, { owner: string; until: number }>();

  private readonly localSubs = new Map<
    string,
    { sandboxId: string; sub: YRoomSubscriber; rooms: Set<string> }
  >();

  private timer: ReturnType<typeof setInterval> | null = null;

  private heartbeat: ReturnType<typeof setInterval> | null = null;

  private readonly timings: YRoomTimings;

  constructor(
    private readonly backend: YRoomBackend,
    private readonly transport: YRoomTransport,
    private readonly files: YRoomFiles,
    timings: Partial<YRoomTimings> = {},
    private readonly warn: (message: string) => void = () => {}
  ) {
    this.timings = { ...DEFAULT_YROOM_TIMINGS, ...timings };
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.timings.pollMs);
    this.timer.unref?.();
    this.heartbeat = setInterval(() => {
      this.beat().catch(() => {});
    }, this.timings.ownerHeartbeatMs);
    this.heartbeat.unref?.();
  }

  get replicaId(): string {
    return this.transport.replicaId;
  }

  ownedRooms(): string[] {
    return [...this.rooms.keys()];
  }

  roomText(room: string): string | null {
    return this.rooms.get(room)?.doc.getText(YROOM_TEXT).toString() ?? null;
  }

  private async ownerOf(room: string): Promise<string> {
    const cached = this.owners.get(room);
    if (cached && cached.until > Date.now()) return cached.owner;
    if (this.rooms.has(room)) {
      this.owners.set(room, {
        owner: this.replicaId,
        until: Date.now() + this.timings.ownerCacheMs
      });
      return this.replicaId;
    }
    const owner = await this.backend.claim(
      yroomOwnerKey(room),
      this.replicaId,
      this.timings.ownerTtlMs
    );
    this.owners.set(room, { owner, until: Date.now() + this.timings.ownerCacheMs });
    return owner;
  }

  async handleLocal(sandboxId: string, room: string, sub: YRoomSubscriber, frame: YClientFrame) {
    await loadYjs();
    const local = this.localSubs.get(sub.connId) ?? { sandboxId, sub, rooms: new Set<string>() };
    local.sub = sub;
    this.localSubs.set(sub.connId, local);
    if (frame.t === 'yjs-leave') {
      local.rooms.delete(room);
    } else {
      local.rooms.add(room);
    }
    let owner: string;
    try {
      owner = await this.ownerOf(room);
    } catch (e: any) {
      this.warn(`yjs owner lookup failed for ${room}: ${e?.message}`);
      this.transport.deliverLocal(sub.connId, {
        t: 'yjs-error',
        room,
        message: 'Collaboration is unavailable right now'
      });
      return;
    }
    if (owner === this.replicaId) {
      await this.process(sandboxId, room, sub, frame);
      return;
    }
    await this.transport.publish(sandboxId, { k: 'y-in', owner, sandboxId, room, sub, frame });
  }

  async connectionClosed(connId: string): Promise<void> {
    const local = this.localSubs.get(connId);
    if (!local) return;
    this.localSubs.delete(connId);
    for (const room of local.rooms) {
      await this.handleLeave(local.sandboxId, room, local.sub).catch(() => {});
    }
  }

  async updateSubscriber(sub: YRoomSubscriber): Promise<void> {
    const local = this.localSubs.get(sub.connId);
    if (!local) return;
    local.sub = sub;
    for (const room of local.rooms) {
      const owned = this.rooms.get(room);
      const entry = owned?.subs.get(subKeyOf(sub));
      if (entry) entry.sub = sub;
      else await this.sendSubHeartbeat(local.sandboxId, room, sub);
    }
  }

  private async handleLeave(sandboxId: string, room: string, sub: YRoomSubscriber) {
    const owner = await this.ownerOf(room).catch(() => null);
    if (!owner) return;
    if (owner === this.replicaId) {
      this.removeSub(room, subKeyOf(sub));
      return;
    }
    await this.transport.publish(sandboxId, {
      k: 'y-left',
      owner,
      room,
      replica: sub.replica,
      connId: sub.connId
    });
  }

  async handleEnvelope(envelope: YEnvelope): Promise<void> {
    await loadYjs();
    if (envelope.k === 'y-out') {
      if (envelope.replica === this.replicaId) {
        this.transport.deliverLocal(envelope.connId, envelope.frame);
      }
      return;
    }
    if (envelope.owner !== this.replicaId) return;
    if (envelope.k === 'y-in') {
      await this.process(envelope.sandboxId, envelope.room, envelope.sub, envelope.frame);
      return;
    }
    if (envelope.k === 'y-sub') {
      const owned = this.rooms.get(envelope.room);
      const entry = owned?.subs.get(subKeyOf(envelope.sub));
      if (entry) {
        entry.seen = Date.now();
        entry.sub = envelope.sub;
      }
      return;
    }
    if (envelope.k === 'y-left') {
      this.removeSub(envelope.room, subKeyOf(envelope));
    }
  }

  private send(room: OwnedRoom, sub: YRoomSubscriber, frame: Record<string, unknown>) {
    if (sub.replica === this.replicaId) {
      this.transport.deliverLocal(sub.connId, frame);
      return;
    }
    this.transport
      .publish(room.sandboxId, { k: 'y-out', replica: sub.replica, connId: sub.connId, frame })
      .catch(() => {});
  }

  private broadcast(room: OwnedRoom, frame: Record<string, unknown>, exceptKey: string | null) {
    for (const [key, entry] of room.subs) {
      if (key === exceptKey) continue;
      this.send(room, entry.sub, frame);
    }
  }

  private async open(sandboxId: string, room: string): Promise<OwnedRoom | null> {
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const pending = this.creating.get(room);
    if (pending) return pending;
    const promise = this.create(sandboxId, room).finally(() => this.creating.delete(room));
    this.creating.set(room, promise);
    return promise;
  }

  private async create(sandboxId: string, room: string): Promise<OwnedRoom | null> {
    await loadYjs();
    const { sid, path } = splitRoom(room);
    const file = await this.files.read(sandboxId, sid, path);
    const doc = new Y.Doc();
    doc.getText(YROOM_TEXT).insert(0, file.content);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const owned: OwnedRoom = {
      room,
      sandboxId,
      sid,
      path,
      doc,
      awareness,
      gen: randomUUID(),
      subs: new Map(),
      lastDisk: file.content,
      baseUpdate: Y.encodeStateAsUpdate(doc),
      hash: file.hash,
      dirty: false,
      version: 0,
      saving: false,
      saveAgain: false,
      saveTimer: null,
      emptySince: Date.now(),
      polling: false,
      destroyed: false
    };
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (owned.destroyed) return;
      owned.version += 1;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      const frame = { t: 'yjs', room, gen: owned.gen, b64: toB64(encoding.toUint8Array(encoder)) };
      const exceptKey = typeof origin === 'string' && owned.subs.has(origin) ? origin : null;
      this.broadcast(owned, frame, exceptKey);
      if (exceptKey) {
        owned.dirty = true;
        this.scheduleSave(owned);
      }
      if (doc.getText(YROOM_TEXT).length > YROOM_MAX_DOC_CHARS) {
        this.reset(owned, 'This file grew too large to edit together');
      }
    });
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        if (owned.destroyed) return;
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
        const exceptKey = typeof origin === 'string' ? origin : null;
        this.broadcast(owned, { t: 'yjs-awareness', room, b64: toB64(update) }, exceptKey);
      }
    );
    this.rooms.set(room, owned);
    this.owners.set(room, { owner: this.replicaId, until: Date.now() + this.timings.ownerCacheMs });
    return owned;
  }

  private addSub(owned: OwnedRoom, sub: YRoomSubscriber): { entry: RoomSub; fresh: boolean } {
    const key = subKeyOf(sub);
    const existing = owned.subs.get(key);
    if (existing) {
      existing.seen = Date.now();
      existing.sub = sub;
      return { entry: existing, fresh: false };
    }
    const entry: RoomSub = { sub, seen: Date.now(), clients: new Set() };
    owned.subs.set(key, entry);
    owned.emptySince = null;
    return { entry, fresh: true };
  }

  private removeSub(room: string, key: string) {
    const owned = this.rooms.get(room);
    if (!owned) return;
    const entry = owned.subs.get(key);
    if (!entry) return;
    owned.subs.delete(key);
    if (entry.clients.size > 0) {
      awarenessProtocol.removeAwarenessStates(owned.awareness, [...entry.clients], key);
    }
    if (owned.subs.size === 0) owned.emptySince = Date.now();
  }

  private async process(
    sandboxId: string,
    room: string,
    sub: YRoomSubscriber,
    frame: YClientFrame
  ) {
    if (frame.t === 'yjs-leave') {
      this.removeSub(room, subKeyOf(sub));
      return;
    }
    let owned: OwnedRoom | null;
    try {
      owned = await this.open(sandboxId, room);
    } catch (e: any) {
      const message = e instanceof YRoomFileError ? e.message : 'Could not open that file';
      if (!(e instanceof YRoomFileError))
        this.warn(`yjs room ${room} failed to open: ${e?.message}`);
      this.sendTo(sandboxId, sub, { t: 'yjs-error', room, message });
      return;
    }
    if (!owned || owned.sandboxId !== sandboxId) return;
    const { entry, fresh } = this.addSub(owned, sub);
    const key = subKeyOf(sub);
    if (fresh) {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, owned.doc);
      this.send(owned, sub, {
        t: 'yjs',
        room,
        gen: owned.gen,
        b64: toB64(encoding.toUint8Array(encoder))
      });
      const states = [...owned.awareness.getStates().keys()];
      if (states.length > 0) {
        this.send(owned, sub, {
          t: 'yjs-awareness',
          room,
          b64: toB64(awarenessProtocol.encodeAwarenessUpdate(owned.awareness, states))
        });
      }
    }
    if (frame.t === 'yjs' && frame.b64) {
      this.handleSync(owned, entry, key, frame);
      return;
    }
    if (frame.t === 'yjs-awareness' && frame.b64) {
      this.handleAwareness(owned, entry, key, frame.b64);
      return;
    }
    if (frame.t === 'yjs-save') {
      if (!canWrite(sub.role)) {
        this.send(owned, sub, { t: 'yjs-denied', room });
        return;
      }
      await this.save(owned, true);
      return;
    }
    if (frame.t === 'yjs-reload') {
      await this.poll(owned);
    }
  }

  private sendTo(sandboxId: string, sub: YRoomSubscriber, frame: Record<string, unknown>) {
    if (sub.replica === this.replicaId) {
      this.transport.deliverLocal(sub.connId, frame);
      return;
    }
    this.transport
      .publish(sandboxId, { k: 'y-out', replica: sub.replica, connId: sub.connId, frame })
      .catch(() => {});
  }

  private handleSync(owned: OwnedRoom, entry: RoomSub, key: string, frame: YClientFrame) {
    let decoder: DecodingModule.Decoder;
    let type: number;
    try {
      decoder = decoding.createDecoder(fromB64(frame.b64!));
      type = decoding.readVarUint(decoder);
    } catch {
      return;
    }
    if (type === syncProtocol.messageYjsSyncStep1) {
      try {
        const stateVector = decoding.readVarUint8Array(decoder);
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep2(encoder, owned.doc, stateVector);
        this.send(owned, entry.sub, {
          t: 'yjs',
          room: owned.room,
          gen: owned.gen,
          b64: toB64(encoding.toUint8Array(encoder))
        });
      } catch {}
      return;
    }
    if (type !== syncProtocol.messageYjsSyncStep2 && type !== syncProtocol.messageYjsUpdate) return;
    if (!canWrite(entry.sub.role)) {
      this.send(owned, entry.sub, { t: 'yjs-denied', room: owned.room });
      return;
    }
    if (frame.gen && frame.gen !== owned.gen) {
      this.send(owned, entry.sub, { t: 'yjs-reset', room: owned.room, gen: owned.gen });
      return;
    }
    try {
      const update = decoding.readVarUint8Array(decoder);
      Y.applyUpdate(owned.doc, update, key);
    } catch (e: any) {
      this.warn(`yjs update rejected in ${owned.room}: ${e?.message}`);
      this.send(owned, entry.sub, { t: 'yjs-reset', room: owned.room, gen: owned.gen });
    }
  }

  private handleAwareness(owned: OwnedRoom, entry: RoomSub, key: string, b64: string) {
    let rebuilt: Uint8Array;
    try {
      const decoder = decoding.createDecoder(fromB64(b64));
      const count = decoding.readVarUint(decoder);
      if (count > 16) return;
      const encoder = encoding.createEncoder();
      const kept: Array<{ clientID: number; clock: number; state: string }> = [];
      for (let i = 0; i < count; i++) {
        const clientID = decoding.readVarUint(decoder);
        const clock = decoding.readVarUint(decoder);
        const raw = decoding.readVarString(decoder);
        if (raw.length > YROOM_MAX_AWARENESS_STATE) continue;
        if (!entry.clients.has(clientID)) {
          if (entry.clients.size >= YROOM_MAX_AWARENESS_CLIENTS) continue;
          const taken = [...owned.subs.values()].some(
            (s) => s !== entry && s.clients.has(clientID)
          );
          if (taken) continue;
          entry.clients.add(clientID);
        }
        let state: unknown = null;
        try {
          state = JSON.parse(raw);
        } catch {
          continue;
        }
        const safe =
          state && typeof state === 'object' && !Array.isArray(state)
            ? {
                ...(state as Record<string, unknown>),
                user: {
                  id: entry.sub.userId,
                  name: entry.sub.name,
                  color: entry.sub.color,
                  role: entry.sub.role
                }
              }
            : null;
        kept.push({ clientID, clock, state: JSON.stringify(safe) });
      }
      encoding.writeVarUint(encoder, kept.length);
      for (const item of kept) {
        encoding.writeVarUint(encoder, item.clientID);
        encoding.writeVarUint(encoder, item.clock);
        encoding.writeVarString(encoder, item.state);
      }
      if (kept.length === 0) return;
      rebuilt = encoding.toUint8Array(encoder);
    } catch {
      return;
    }
    try {
      awarenessProtocol.applyAwarenessUpdate(owned.awareness, rebuilt, key);
    } catch {}
  }

  private scheduleSave(owned: OwnedRoom) {
    if (owned.saveTimer) clearTimeout(owned.saveTimer);
    owned.saveTimer = setTimeout(() => {
      owned.saveTimer = null;
      this.save(owned, false).catch(() => {});
    }, this.timings.saveDebounceMs);
    owned.saveTimer.unref?.();
  }

  private merge(owned: OwnedRoom, content: string, hash: string) {
    if (content === owned.lastDisk) {
      owned.hash = hash;
      return;
    }
    const temp = new Y.Doc();
    try {
      Y.applyUpdate(temp, owned.baseUpdate);
      const text = temp.getText(YROOM_TEXT);
      const base = text.toString();
      const diff = simpleDiffString(base, content);
      temp.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove);
        if (diff.insert.length > 0) text.insert(diff.index, diff.insert);
      });
      const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVectorFromUpdate(owned.baseUpdate));
      Y.applyUpdate(owned.doc, update, 'disk');
      owned.baseUpdate = Y.encodeStateAsUpdate(temp);
      owned.lastDisk = content;
      owned.hash = hash;
    } finally {
      temp.destroy();
    }
    if (!owned.dirty) {
      const current = owned.doc.getText(YROOM_TEXT).toString();
      if (current !== content) owned.dirty = true;
    }
    this.broadcast(owned, { t: 'yjs-disk', room: owned.room, hash }, null);
  }

  private async poll(owned: OwnedRoom): Promise<void> {
    if (owned.destroyed || owned.polling || owned.saving) return;
    owned.polling = true;
    try {
      const hash = await this.files.stat(owned.sandboxId, owned.sid, owned.path);
      if (owned.destroyed || hash === null || hash === owned.hash || owned.saving) return;
      const file = await this.files.read(owned.sandboxId, owned.sid, owned.path);
      if (owned.destroyed || owned.saving) return;
      this.merge(owned, file.content, file.hash);
    } catch (e: any) {
      if (!(e instanceof YRoomFileError))
        this.warn(`yjs poll failed for ${owned.room}: ${e?.message}`);
    } finally {
      owned.polling = false;
    }
  }

  private async save(owned: OwnedRoom, explicit: boolean): Promise<void> {
    if (owned.destroyed) return;
    if (owned.saving) {
      owned.saveAgain = true;
      return;
    }
    if (!owned.dirty && !explicit) return;
    owned.saving = true;
    try {
      const diskHash = await this.files.stat(owned.sandboxId, owned.sid, owned.path);
      if (diskHash !== null && diskHash !== owned.hash) {
        const file = await this.files.read(owned.sandboxId, owned.sid, owned.path);
        this.merge(owned, file.content, file.hash);
      }
      const content = owned.doc.getText(YROOM_TEXT).toString();
      const snapshot = Y.encodeStateAsUpdate(owned.doc);
      const version = owned.version;
      if (content === owned.lastDisk) {
        owned.dirty = false;
        owned.baseUpdate = snapshot;
        if (explicit)
          this.broadcast(owned, { t: 'yjs-saved', room: owned.room, hash: owned.hash }, null);
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > YROOM_MAX_FILE_BYTES) {
        this.broadcast(
          owned,
          { t: 'yjs-error', room: owned.room, message: 'File is too large to save (500KB max)' },
          null
        );
        return;
      }
      const hash = await this.files.write(owned.sandboxId, owned.sid, owned.path, content);
      owned.lastDisk = content;
      owned.baseUpdate = snapshot;
      owned.hash = hash;
      if (owned.version === version) owned.dirty = false;
      this.broadcast(owned, { t: 'yjs-saved', room: owned.room, hash }, null);
    } catch (e: any) {
      const message = e instanceof YRoomFileError ? e.message : 'Could not save that file';
      if (!(e instanceof YRoomFileError))
        this.warn(`yjs save failed for ${owned.room}: ${e?.message}`);
      this.broadcast(owned, { t: 'yjs-error', room: owned.room, message }, null);
    } finally {
      owned.saving = false;
      if (owned.saveAgain || (owned.dirty && !owned.destroyed)) {
        owned.saveAgain = false;
        if (owned.dirty) this.scheduleSave(owned);
      }
    }
  }

  private reset(owned: OwnedRoom, message: string) {
    this.broadcast(owned, { t: 'yjs-reset', room: owned.room, gen: null, message }, null);
    this.destroy(owned, false).catch(() => {});
  }

  private async destroy(owned: OwnedRoom, flush: boolean): Promise<void> {
    if (owned.destroyed) return;
    if (owned.saveTimer) {
      clearTimeout(owned.saveTimer);
      owned.saveTimer = null;
    }
    if (flush && owned.dirty) await this.save(owned, false).catch(() => {});
    owned.destroyed = true;
    this.rooms.delete(owned.room);
    this.owners.delete(owned.room);
    owned.awareness.destroy();
    owned.doc.destroy();
    await this.backend.release(yroomOwnerKey(owned.room), this.replicaId).catch(() => {});
  }

  private async sendSubHeartbeat(sandboxId: string, room: string, sub: YRoomSubscriber) {
    const owner = await this.ownerOf(room).catch(() => null);
    if (!owner) return;
    if (owner === this.replicaId) {
      const owned = this.rooms.get(room);
      const entry = owned?.subs.get(subKeyOf(sub));
      if (entry) entry.seen = Date.now();
      return;
    }
    await this.transport.publish(sandboxId, { k: 'y-sub', owner, room, sub });
  }

  async tick(): Promise<void> {
    const now = Date.now();
    for (const owned of [...this.rooms.values()]) {
      for (const [key, entry] of owned.subs) {
        if (entry.sub.replica === this.replicaId) {
          if (this.localSubs.get(entry.sub.connId)?.rooms.has(owned.room)) entry.seen = now;
        }
        if (now - entry.seen > this.timings.subscriberTtlMs) this.removeSub(owned.room, key);
      }
      if (owned.subs.size === 0) {
        if (owned.emptySince === null) owned.emptySince = now;
        if (now - owned.emptySince >= this.timings.emptyTtlMs) {
          await this.destroy(owned, true);
        }
        continue;
      }
      await this.poll(owned);
    }
  }

  private async beat(): Promise<void> {
    for (const owned of [...this.rooms.values()]) {
      const ok = await this.backend
        .refresh(yroomOwnerKey(owned.room), this.replicaId, this.timings.ownerTtlMs)
        .catch(() => true);
      if (!ok) {
        this.warn(`lost ownership of yjs room ${owned.room}`);
        await this.destroy(owned, true);
        this.broadcast(owned, { t: 'yjs-reset', room: owned.room, gen: null }, null);
      }
    }
    for (const local of this.localSubs.values()) {
      for (const room of local.rooms) {
        if (this.rooms.has(room)) continue;
        await this.sendSubHeartbeat(local.sandboxId, room, local.sub).catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    for (const owned of [...this.rooms.values()]) await this.destroy(owned, true);
  }
}
