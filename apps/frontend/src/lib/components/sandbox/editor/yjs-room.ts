import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { diffText, mergeText } from './text-diff';

export const YROOM_TEXT = 'content';
export const REMOTE_ORIGIN = 'remote';
export const RECOVERY_ORIGIN = 'recovery';
const MAX_BASE_CHARS = 1_000_000;
const ACK_TIMEOUT_MS = 10_000;
const AWARENESS_GAP_MS = 60;

export type YFrame = Record<string, unknown> & { t: string };

export type CollabStatus =
	| 'connecting'
	| 'syncing'
	| 'synced'
	| 'offline'
	| 'reconnecting'
	| 'error';

export type RoomEvent = 'status' | 'peers' | 'doc' | 'saved' | 'error';

export interface RoomPeer {
	clientId: number;
	userId: string;
	name: string;
	color: unknown;
	anchor: number;
	head: number;
}

export interface YjsRoomOptions {
	canWrite: boolean;
	selfId?: string | null;
	ackTimeoutMs?: number;
	now?: () => number;
}

export function frameRoom(sid: string, rel: string): string {
	return `file:${sid}:${rel}`;
}

export function applyTextDiff(text: Y.Text, from: string, to: string) {
	const edits = diffText(from, to);
	for (let i = edits.length - 1; i >= 0; i--) {
		const edit = edits[i];
		if (edit.remove > 0) text.delete(edit.index, edit.remove);
		if (edit.insert.length > 0) text.insert(edit.index, edit.insert);
	}
}

function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
	const x = Y.decodeStateVector(a);
	const y = Y.decodeStateVector(b);
	if (x.size !== y.size) return false;
	for (const [client, clock] of x) if (y.get(client) !== clock) return false;
	return true;
}

function decodeB64(value: unknown): Uint8Array | null {
	if (typeof value !== 'string' || !value) return null;
	try {
		return fromBase64(value);
	} catch {
		return null;
	}
}

export class YjsRoom {
	readonly room: string;
	readonly local = { origin: 'local' };
	readonly awareness: awarenessProtocol.Awareness;
	doc: Y.Doc;
	text: Y.Text;
	undo: Y.UndoManager;
	gen: string | null = null;
	canWrite: boolean;
	connected = false;
	synced = false;
	everSynced = false;
	error: string | null = null;
	base: { hash: string; text: string } | null = null;
	lastSavedHash: string | null = null;

	readonly #send: (frame: YFrame) => boolean;
	readonly #listeners = new Set<(event: RoomEvent) => void>();
	readonly #awarenessDoc = new Y.Doc();
	readonly #pending = new Map<number, number>();
	readonly #selfId: string | null;
	readonly #ackTimeoutMs: number;
	readonly #now: () => number;
	#seq = 0;
	#unpushed = false;
	#offlineEdits = false;
	#handshakeAt = 0;
	#recovery: { ours: string; base: string | null } | null = null;
	#destroyed = false;
	#awarenessAt = 0;
	#awarenessTimer: ReturnType<typeof setTimeout> | null = null;
	#detachDoc: () => void = () => {};

	constructor(room: string, send: (frame: YFrame) => boolean, options: YjsRoomOptions) {
		this.room = room;
		this.#send = send;
		this.canWrite = options.canWrite;
		this.#selfId = options.selfId ?? null;
		this.#ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
		this.doc = new Y.Doc();
		this.text = this.doc.getText(YROOM_TEXT);
		this.undo = this.#undoFor(this.text);
		this.#wireDoc();
		this.awareness = new awarenessProtocol.Awareness(this.#awarenessDoc);
		this.awareness.on(
			'update',
			(
				{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
				origin: unknown
			) => {
				if (origin === 'local') {
					this.#sendAwareness();
					return;
				}
				if (added.length + updated.length + removed.length > 0) this.#emit('peers');
			}
		);
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	get status(): CollabStatus {
		if (this.error && !this.everSynced) return 'error';
		if (!this.connected) {
			if (this.#handshakeAt === 0 && !this.everSynced) return 'connecting';
			return this.#offlineEdits || this.#unpushed || this.#pending.size > 0
				? 'offline'
				: 'reconnecting';
		}
		if (!this.synced || this.#unpushed || this.#pending.size > 0) return 'syncing';
		return 'synced';
	}

	on(listener: (event: RoomEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RoomEvent) {
		for (const listener of [...this.#listeners]) listener(event);
	}

	#undoFor(text: Y.Text): Y.UndoManager {
		return new Y.UndoManager(text, { trackedOrigins: new Set([this.local]), captureTimeout: 500 });
	}

	#wireDoc() {
		const doc = this.doc;
		const onUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE_ORIGIN || this.#destroyed) return;
			if (!this.canWrite) return;
			if (!this.connected || !this.synced || this.#unpushed) {
				this.#unpushed = true;
				if (!this.connected) this.#offlineEdits = true;
				this.#emit('status');
				return;
			}
			const encoder = encoding.createEncoder();
			syncProtocol.writeUpdate(encoder, update);
			this.#sendTracked(
				{ t: 'yjs', room: this.room, gen: this.gen },
				encoding.toUint8Array(encoder)
			);
		};
		doc.on('update', onUpdate);
		this.#detachDoc = () => doc.off('update', onUpdate);
	}

	#sendTracked(frame: YFrame, payload: Uint8Array) {
		const n = ++this.#seq;
		const sent = this.#send({ ...frame, b64: toBase64(payload), n });
		if (!sent) {
			this.#unpushed = true;
			this.#emit('status');
			return;
		}
		this.#pending.set(n, this.#now());
		this.#emit('status');
	}

	#sendAwareness(now = false) {
		if (!this.connected || this.#destroyed) return;
		const wait = AWARENESS_GAP_MS - (this.#now() - this.#awarenessAt);
		if (!now && wait > 0) {
			this.#awarenessTimer ??= setTimeout(() => {
				this.#awarenessTimer = null;
				this.#sendAwareness(true);
			}, wait);
			return;
		}
		if (this.#awarenessTimer) clearTimeout(this.#awarenessTimer);
		this.#awarenessTimer = null;
		this.#awarenessAt = this.#now();
		const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
			this.awareness.clientID
		]);
		this.#send({ t: 'yjs-awareness', room: this.room, b64: toBase64(update) });
	}

	#handshake() {
		const encoder = encoding.createEncoder();
		syncProtocol.writeSyncStep1(encoder, this.doc);
		this.#handshakeAt = this.#now();
		this.synced = false;
		this.#send({
			t: 'yjs',
			room: this.room,
			gen: this.gen,
			b64: toBase64(encoding.toUint8Array(encoder))
		});
	}

	connect() {
		if (this.#destroyed) return;
		this.connected = true;
		this.synced = false;
		if (this.#pending.size > 0) this.#unpushed = true;
		this.#pending.clear();
		this.#handshake();
		if (this.awareness.getLocalState() !== null) this.#sendAwareness();
		this.#emit('status');
	}

	disconnect() {
		if (!this.connected) return;
		this.connected = false;
		this.synced = false;
		if (this.#pending.size > 0) {
			this.#unpushed = true;
			this.#offlineEdits = true;
		}
		this.#pending.clear();
		this.#emit('status');
	}

	tick() {
		if (!this.connected || this.#destroyed) return;
		const now = this.#now();
		const oldest = Math.min(...this.#pending.values());
		const stalled = this.#pending.size > 0 && now - oldest > this.#ackTimeoutMs;
		const unsynced = !this.synced && now - this.#handshakeAt > this.#ackTimeoutMs;
		if (!stalled && !unsynced) return;
		if (this.#pending.size > 0) this.#unpushed = true;
		this.#pending.clear();
		this.#handshake();
		this.#emit('status');
	}

	receive(frame: YFrame) {
		if (this.#destroyed) return;
		switch (frame.t) {
			case 'yjs':
				this.#onSync(frame);
				return;
			case 'yjs-ack': {
				if (typeof frame.n === 'number') this.#pending.delete(frame.n);
				this.#emit('status');
				return;
			}
			case 'yjs-awareness': {
				const bytes = decodeB64(frame.b64);
				if (!bytes) return;
				try {
					awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, REMOTE_ORIGIN);
				} catch {
					return;
				}
				return;
			}
			case 'yjs-reset':
				this.#onReset(frame);
				return;
			case 'yjs-denied':
				this.canWrite = false;
				this.#unpushed = false;
				this.#pending.clear();
				this.#emit('status');
				return;
			case 'yjs-saved':
			case 'yjs-disk':
			case 'yjs-base':
				this.#onDisk(frame);
				return;
			case 'yjs-error':
				this.error = typeof frame.message === 'string' ? frame.message : 'Collaboration failed';
				this.#emit('error');
				this.#emit('status');
				return;
			default:
				return;
		}
	}

	#onSync(frame: YFrame) {
		const gen = typeof frame.gen === 'string' && frame.gen ? frame.gen : null;
		if (gen && this.gen && gen !== this.gen) {
			if (this.#now() - this.#handshakeAt > 250) this.#handshake();
			return;
		}
		if (gen && !this.gen) this.gen = gen;
		const bytes = decodeB64(frame.b64);
		if (!bytes) return;
		try {
			const decoder = decoding.createDecoder(bytes);
			const type = decoding.readVarUint(decoder);
			if (type === syncProtocol.messageYjsSyncStep1) {
				const sv = decoding.readVarUint8Array(decoder);
				if (!this.canWrite) return;
				this.#unpushed = false;
				this.#offlineEdits = false;
				const encoder = encoding.createEncoder();
				syncProtocol.writeSyncStep2(encoder, this.doc, sv);
				this.#sendTracked(
					{ t: 'yjs', room: this.room, gen: this.gen },
					encoding.toUint8Array(encoder)
				);
				return;
			}
			if (type !== syncProtocol.messageYjsSyncStep2 && type !== syncProtocol.messageYjsUpdate) {
				return;
			}
			const update = decoding.readVarUint8Array(decoder);
			Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
			if (type === syncProtocol.messageYjsSyncStep2) {
				this.synced = true;
				this.everSynced = true;
				this.error = null;
				this.#finishRecovery();
			}
			this.#emit('status');
		} catch {
			return;
		}
	}

	#unsavedText(): string | null {
		if (!this.canWrite) return null;
		const ours = this.text.toString();
		if (this.base) return ours !== this.base.text ? ours : null;
		return this.#unpushed || this.#offlineEdits || this.#pending.size > 0 ? ours : null;
	}

	#onReset(frame: YFrame) {
		const message = typeof frame.message === 'string' ? frame.message : null;
		const gen = typeof frame.gen === 'string' && frame.gen ? frame.gen : null;
		if (message) {
			this.error = message;
			this.#replaceDoc(null);
			this.base = null;
			this.#recovery = null;
			this.#emit('error');
			if (this.connected) this.#handshake();
			return;
		}
		if (!gen) {
			if (this.connected) this.#handshake();
			return;
		}
		if (frame.adopt === true && this.canWrite && this.gen && this.text.length > 0) {
			const update = Y.encodeStateAsUpdate(this.doc);
			const base =
				this.base && this.base.text.length <= MAX_BASE_CHARS ? this.base.text : undefined;
			this.#unpushed = false;
			this.#offlineEdits = false;
			this.#sendTracked(
				{
					t: 'yjs-adopt',
					room: this.room,
					gen: this.gen,
					...(this.base ? { hash: this.base.hash } : {}),
					...(base !== undefined ? { base } : {})
				},
				update
			);
			return;
		}
		const ours = this.#unsavedText();
		this.#recovery = ours === null ? null : { ours, base: this.base?.text ?? null };
		this.#replaceDoc(gen);
		if (this.connected) this.#handshake();
	}

	#replaceDoc(gen: string | null) {
		this.#detachDoc();
		this.undo.destroy();
		this.doc = new Y.Doc();
		this.text = this.doc.getText(YROOM_TEXT);
		this.undo = this.#undoFor(this.text);
		this.gen = gen;
		this.synced = false;
		this.#unpushed = false;
		this.#offlineEdits = false;
		this.#pending.clear();
		this.#wireDoc();
		this.#emit('doc');
		this.#emit('status');
	}

	#finishRecovery() {
		const recovery = this.#recovery;
		this.#recovery = null;
		if (!recovery || !this.canWrite) return;
		const theirs = this.text.toString();
		const merged = mergeText(recovery.base ?? theirs, recovery.ours, theirs);
		if (merged === theirs) return;
		this.doc.transact(() => applyTextDiff(this.text, theirs, merged), RECOVERY_ORIGIN);
	}

	#onDisk(frame: YFrame) {
		const hash = typeof frame.hash === 'string' ? frame.hash : null;
		if (!hash) return;
		const sv = decodeB64(frame.sv);
		if (sv && sameStateVector(sv, Y.encodeStateVector(this.doc))) {
			this.base = { hash, text: this.text.toString() };
		}
		if (frame.t === 'yjs-saved') {
			this.lastSavedHash = hash;
			this.#emit('saved');
		}
	}

	save(): boolean {
		if (!this.canWrite || !this.connected) return false;
		return this.#send({ t: 'yjs-save', room: this.room });
	}

	reload() {
		if (this.connected) this.#send({ t: 'yjs-reload', room: this.room });
	}

	setCursor(anchor: number | null, head: number | null = anchor) {
		if (this.#destroyed) return;
		if (anchor === null || head === null) {
			this.awareness.setLocalStateField('cursor', null);
			return;
		}
		const at = (index: number) =>
			Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, index));
		this.awareness.setLocalStateField('cursor', { anchor: at(anchor), head: at(head) });
	}

	peers(): RoomPeer[] {
		const out: RoomPeer[] = [];
		const length = this.text.length;
		for (const [clientId, state] of this.awareness.getStates()) {
			if (clientId === this.awareness.clientID || !state) continue;
			const user = (state as { user?: Record<string, unknown> }).user;
			const cursor = (state as { cursor?: { anchor?: unknown; head?: unknown } | null }).cursor;
			if (!user || typeof user.id !== 'string' || !cursor) continue;
			if (this.#selfId && user.id === this.#selfId) continue;
			const anchor = this.#absolute(cursor.anchor);
			const head = this.#absolute(cursor.head);
			if (anchor === null || head === null) continue;
			out.push({
				clientId,
				userId: user.id,
				name: typeof user.name === 'string' ? user.name : 'Someone',
				color: user.color,
				anchor: Math.min(anchor, length),
				head: Math.min(head, length)
			});
		}
		return out;
	}

	#absolute(json: unknown): number | null {
		if (!json || typeof json !== 'object') return null;
		try {
			const rel = Y.createRelativePositionFromJSON(json);
			const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.doc);
			return abs && abs.type === this.text ? abs.index : null;
		} catch {
			return null;
		}
	}

	destroy() {
		if (this.#destroyed) return;
		if (this.connected) {
			this.awareness.setLocalState(null);
			this.#sendAwareness(true);
			this.#send({ t: 'yjs-leave', room: this.room });
		}
		if (this.#awarenessTimer) clearTimeout(this.#awarenessTimer);
		this.#awarenessTimer = null;
		this.#destroyed = true;
		this.connected = false;
		this.#listeners.clear();
		this.#detachDoc();
		this.undo.destroy();
		this.awareness.destroy();
		this.#awarenessDoc.destroy();
		this.doc.destroy();
	}
}
