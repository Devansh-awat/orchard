import type * as Monaco from 'monaco-editor';
import { SvelteMap } from 'svelte/reactivity';
import {
	TextBinding,
	YjsRoom,
	frameRoom,
	type CollabBinding,
	type CollabStatus,
	type EditorWorkspace,
	type RemoteCursor
} from '$lib/components/sandbox/editor';
import { presenceColorVar } from './format';
import type { LiveClient } from './live.svelte';

export const MAX_COLLAB_ROOMS = 6;
const TICK_MS = 5000;
const JOIN_TIMEOUT_MS = 8000;

export const COLLAB_STATUS_LABEL: Record<CollabStatus, string> = {
	connecting: 'Connecting…',
	syncing: 'Syncing…',
	synced: 'Synced',
	offline: 'Offline, edits saved locally',
	reconnecting: 'Reconnecting',
	error: 'Not shared'
};

export class CollabFile implements CollabBinding {
	readonly path: string;
	readonly room: YjsRoom;
	status = $state<CollabStatus>('connecting');
	cursors = $state.raw<RemoteCursor[]>([]);
	error = $state<string | null>(null);
	ready = $state(false);
	paused = $state(false);
	unsupported = $state(false);
	usedAt = 0;
	mounted = 0;

	readonly #editor: EditorWorkspace;
	readonly #off: () => void;
	#binding: TextBinding | null = null;
	#model: Monaco.editor.ITextModel | null = null;
	#cursorFrame = 0;

	constructor(path: string, room: YjsRoom, editor: EditorWorkspace) {
		this.path = path;
		this.room = room;
		this.#editor = editor;
		this.#off = room.on((event) => this.#onRoom(event));
		this.#sync();
	}

	giveUp() {
		if (!this.ready) this.unsupported = true;
	}

	get failed(): boolean {
		return this.unsupported || (this.status === 'error' && !this.room.everSynced);
	}

	get active(): boolean {
		return this.ready && !this.failed;
	}

	#onRoom(event: string) {
		if (event === 'doc') this.paused = true;
		if (event === 'peers' || event === 'doc') this.#queueCursors();
		if (event === 'saved' || event === 'status') this.#markSaved();
		this.#sync();
	}

	#sync() {
		this.status = this.room.status;
		this.error = this.room.error;
		if (this.room.synced && !this.ready) this.ready = true;
		if (this.room.synced && this.paused) this.paused = false;
	}

	#markSaved() {
		const base = this.room.base;
		const model = this.#model;
		if (!base || !model || model.isDisposed()) return;
		if (base.text !== this.room.text.toString() || model.getValue() !== base.text) return;
		this.#editor.get(this.path)?.markSaved();
	}

	#queueCursors() {
		if (this.#cursorFrame) return;
		const run = () => {
			this.#cursorFrame = 0;
			this.#updateCursors();
		};
		this.#cursorFrame =
			typeof requestAnimationFrame === 'function'
				? requestAnimationFrame(run)
				: (setTimeout(run, 16) as unknown as number);
	}

	#updateCursors() {
		const model = this.#model;
		if (!model || model.isDisposed() || !this.#binding || this.#binding.waiting) {
			this.cursors = [];
			return;
		}
		this.cursors = this.room.peers().map((peer) => {
			const head = model.getPositionAt(peer.head);
			const anchor = model.getPositionAt(peer.anchor);
			const [start, end] = peer.anchor <= peer.head ? [anchor, head] : [head, anchor];
			return {
				userId: `${peer.userId}:${peer.clientId}`,
				name: peer.name.split(' ')[0] || peer.name,
				colorVar: presenceColorVar({ id: peer.userId, color: peer.color }),
				line: head.lineNumber,
				col: head.column,
				selection:
					peer.anchor === peer.head
						? null
						: {
								startLine: start.lineNumber,
								startCol: start.column,
								endLine: end.lineNumber,
								endCol: end.column
							}
			};
		});
	}

	bind(model: Monaco.editor.ITextModel, editor: Monaco.editor.IStandaloneCodeEditor): () => void {
		if (!TextBinding.supports(model)) {
			this.unsupported = true;
			return () => {};
		}
		this.mounted += 1;
		this.#model = model;
		this.#binding?.dispose();
		const binding = new TextBinding(this.room, model, () => this.#queueCursors());
		this.#binding = binding;
		const disposables: Array<{ dispose(): void }> = [];
		const monaco = this.#editor.monaco;
		if (monaco) {
			disposables.push(
				editor.addAction({
					id: 'orchard.collab.undo',
					label: 'Undo',
					keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ],
					run: () => {
						if (!binding.waiting) this.room.undo.undo();
					}
				}),
				editor.addAction({
					id: 'orchard.collab.redo',
					label: 'Redo',
					keybindings: [
						monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
						monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY
					],
					run: () => {
						if (!binding.waiting) this.room.undo.redo();
					}
				})
			);
		}
		disposables.push(
			editor.onDidChangeCursorSelection((event) => {
				if (binding.waiting || editor.getModel() !== model) return;
				const sel = event.selection;
				const anchor = model.getOffsetAt({
					lineNumber: sel.selectionStartLineNumber,
					column: sel.selectionStartColumn
				});
				const head = model.getOffsetAt({
					lineNumber: sel.positionLineNumber,
					column: sel.positionColumn
				});
				this.room.setCursor(anchor, head);
			}),
			editor.onDidBlurEditorText(() => this.room.setCursor(null))
		);
		this.#markSaved();
		this.#queueCursors();
		return () => {
			for (const item of disposables) item.dispose();
			binding.dispose();
			if (this.#binding === binding) {
				this.#binding = null;
				this.#model = null;
				this.cursors = [];
			}
			this.room.setCursor(null);
			this.mounted = Math.max(0, this.mounted - 1);
		};
	}

	dispose() {
		this.#off();
		this.#binding?.dispose();
		this.#binding = null;
		if (this.#cursorFrame && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(this.#cursorFrame);
		}
		this.room.destroy();
	}
}

export interface CollabTarget {
	sid: string;
	rel: string;
}

export class CollabFiles {
	readonly files = new SvelteMap<string, CollabFile>();
	readonly #live: LiveClient;
	readonly #editor: EditorWorkspace;
	readonly #canWrite: () => boolean;
	readonly #selfId: () => string | null;
	readonly #target: (path: string) => CollabTarget | null;
	readonly #detach = new Map<string, () => void>();
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: {
		live: LiveClient;
		editor: EditorWorkspace;
		canWrite: () => boolean;
		selfId: () => string | null;
		target: (path: string) => CollabTarget | null;
	}) {
		this.#live = options.live;
		this.#editor = options.editor;
		this.#canWrite = options.canWrite;
		this.#selfId = options.selfId;
		this.#target = options.target;
		this.#editor.saveHook = (path) => this.save(path);
	}

	get(path: string): CollabFile | null {
		return this.files.get(path) ?? null;
	}

	acquire(path: string): CollabFile | null {
		const known = this.files.get(path);
		if (known) {
			known.usedAt = Date.now();
			return known.failed ? null : known;
		}
		const target = this.#target(path);
		if (!target || this.#editor.isDirty(path)) return null;
		this.#evict();
		const name = frameRoom(target.sid, target.rel);
		const room = new YjsRoom(name, (frame) => this.#live.sendRoom(frame), {
			canWrite: this.#canWrite(),
			selfId: this.#selfId()
		});
		const file = new CollabFile(path, room, this.#editor);
		file.usedAt = Date.now();
		this.files.set(path, file);
		this.#detach.set(path, this.#live.attachRoom(name, room));
		room.on((event) => {
			if (event === 'error' && !room.everSynced) queueMicrotask(() => this.release(path));
		});
		this.#startTimer();
		setTimeout(() => {
			if (this.files.get(path) !== file || file.ready) return;
			file.giveUp();
			this.release(path);
		}, JOIN_TIMEOUT_MS);
		return file;
	}

	#evict() {
		if (this.files.size < MAX_COLLAB_ROOMS) return;
		const idle = [...this.files.values()]
			.filter((file) => file.mounted === 0)
			.sort((a, b) => a.usedAt - b.usedAt)[0];
		if (idle) this.release(idle.path);
	}

	#startTimer() {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			for (const file of this.files.values()) file.room.tick();
		}, TICK_MS);
	}

	save(path: string): boolean {
		const file = this.files.get(path);
		if (!file?.active) return false;
		file.room.save();
		return true;
	}

	reloadAll() {
		for (const file of this.files.values()) file.room.reload();
	}

	release(path: string) {
		const file = this.files.get(path);
		if (!file) return;
		if (file.room.everSynced) file.room.save();
		this.#detach.get(path)?.();
		this.#detach.delete(path);
		this.files.delete(path);
		file.dispose();
		if (this.files.size === 0 && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	dispose() {
		for (const path of [...this.files.keys()]) this.release(path);
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#editor.saveHook = null;
	}
}
