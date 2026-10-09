import type * as Y from 'yjs';
import { diffText } from './text-diff';
import type { YjsRoom } from './yjs-room';

export interface BindingPosition {
	lineNumber: number;
	column: number;
}

export interface BindingRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export interface BindingChange {
	rangeOffset: number;
	rangeLength: number;
	text: string;
}

export interface BindingModel {
	getValue(): string;
	getEOL(): string;
	getPositionAt(offset: number): BindingPosition;
	applyEdits(edits: { range: BindingRange; text: string; forceMoveMarkers?: boolean }[]): unknown;
	onDidChangeContent(listener: (event: { changes: readonly BindingChange[] }) => void): {
		dispose(): void;
	};
}

type Edit = { start: number; end: number; text: string };

export class TextBinding {
	readonly room: YjsRoom;
	readonly model: BindingModel;
	#text: Y.Text | null = null;
	#muted = false;
	#waiting = false;
	#disposed = false;
	readonly #offModel: { dispose(): void };
	readonly #offRoom: () => void;
	readonly #onChange: (() => void) | null;

	constructor(room: YjsRoom, model: BindingModel, onChange: (() => void) | null = null) {
		this.room = room;
		this.model = model;
		this.#onChange = onChange;
		this.#offModel = model.onDidChangeContent((event) => this.#fromModel(event.changes));
		this.#offRoom = room.on((event) => {
			if (event === 'doc') this.#attach();
			else if (event === 'status' && this.#waiting && room.synced) this.#attach();
		});
		this.#attach();
	}

	static supports(model: BindingModel): boolean {
		return model.getEOL() === '\n' && !model.getValue().includes('\r');
	}

	#observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
		if (this.#disposed || transaction.origin === this.room.local) return;
		const edits: Edit[] = [];
		let index = 0;
		for (const op of event.delta) {
			if (op.retain !== undefined) {
				index += op.retain;
			} else if (typeof op.insert === 'string') {
				edits.push({ start: index, end: index, text: op.insert });
			} else if (op.delete !== undefined) {
				edits.push({ start: index, end: index + op.delete, text: '' });
				index += op.delete;
			}
		}
		this.#applyToModel(edits);
		this.#onChange?.();
	};

	get waiting(): boolean {
		return this.#waiting;
	}

	#attach() {
		if (this.#disposed) return;
		this.#text?.unobserve(this.#observer);
		this.#text = null;
		if (!this.room.synced) {
			this.#waiting = true;
			return;
		}
		this.#waiting = false;
		this.#text = this.room.text;
		this.#text.observe(this.#observer);
		this.reconcile();
	}

	reconcile() {
		const want = this.room.text.toString();
		const have = this.model.getValue();
		if (want === have) return;
		this.#applyToModel(
			diffText(have, want).map((edit) => ({
				start: edit.index,
				end: edit.index + edit.remove,
				text: edit.insert
			}))
		);
		this.#onChange?.();
	}

	#applyToModel(raw: Edit[]) {
		const edits: Edit[] = [];
		for (const edit of raw) {
			const last = edits[edits.length - 1];
			if (last && last.end === edit.start) {
				edits[edits.length - 1] = { start: last.start, end: edit.end, text: last.text + edit.text };
			} else {
				edits.push(edit);
			}
		}
		if (edits.length === 0) return;
		const ranged = edits.map((edit) => {
			const start = this.model.getPositionAt(edit.start);
			const end = edit.end === edit.start ? start : this.model.getPositionAt(edit.end);
			return {
				range: {
					startLineNumber: start.lineNumber,
					startColumn: start.column,
					endLineNumber: end.lineNumber,
					endColumn: end.column
				},
				text: edit.text,
				forceMoveMarkers: false
			};
		});
		this.#muted = true;
		try {
			this.model.applyEdits(ranged);
		} finally {
			this.#muted = false;
		}
	}

	#fromModel(changes: readonly BindingChange[]) {
		if (this.#muted || this.#disposed || this.#waiting) return;
		const text = this.room.text;
		const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
		this.room.doc.transact(() => {
			for (const change of ordered) {
				if (change.rangeLength > 0) text.delete(change.rangeOffset, change.rangeLength);
				if (change.text) text.insert(change.rangeOffset, change.text);
			}
		}, this.room.local);
		this.#onChange?.();
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#text?.unobserve(this.#observer);
		this.#offModel.dispose();
		this.#offRoom();
	}
}
