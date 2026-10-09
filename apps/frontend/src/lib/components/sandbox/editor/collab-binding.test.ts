import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { toBase64 } from 'lib0/buffer';
import {
	TextBinding,
	type BindingChange,
	type BindingModel,
	type BindingRange
} from './text-binding';
import { REMOTE_ORIGIN, YjsRoom, type YFrame } from './yjs-room';
import { mergeText } from './text-diff';

class FakeModel implements BindingModel {
	value: string;
	eol = '\n';
	edits = 0;
	readonly listeners = new Set<(event: { changes: readonly BindingChange[] }) => void>();

	constructor(value: string) {
		this.value = value;
	}

	getValue() {
		return this.value;
	}

	getEOL() {
		return this.eol;
	}

	getPositionAt(offset: number) {
		const before = this.value.slice(0, offset).split('\n');
		return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
	}

	offsetAt(line: number, column: number): number {
		const lines = this.value.split('\n');
		let offset = 0;
		for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
		return offset + column - 1;
	}

	#change(changes: BindingChange[]) {
		const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
		for (const c of ordered) {
			this.value =
				this.value.slice(0, c.rangeOffset) +
				c.text +
				this.value.slice(c.rangeOffset + c.rangeLength);
		}
		for (const listener of this.listeners) listener({ changes });
	}

	applyEdits(edits: { range: BindingRange; text: string }[]) {
		this.edits += edits.length;
		this.#change(
			edits.map((e) => {
				const start = this.offsetAt(e.range.startLineNumber, e.range.startColumn);
				const end = this.offsetAt(e.range.endLineNumber, e.range.endColumn);
				return { rangeOffset: start, rangeLength: end - start, text: e.text };
			})
		);
	}

	type(offset: number, remove: number, text: string) {
		this.#change([{ rangeOffset: offset, rangeLength: remove, text }]);
	}

	onDidChangeContent(listener: (event: { changes: readonly BindingChange[] }) => void) {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
}

const rooms: YjsRoom[] = [];

afterEach(() => {
	for (const room of rooms.splice(0)) room.destroy();
});

function syncedRoom(content: string, sent: YFrame[] = []) {
	const room = new YjsRoom('file:s:a.ts', (frame) => (sent.push(frame), true), { canWrite: true });
	rooms.push(room);
	const server = new Y.Doc();
	server.getText('content').insert(0, content);
	room.connect();
	const encoder = encoding.createEncoder();
	syncProtocol.writeSyncStep2(encoder, server, Y.encodeStateVector(room.doc));
	room.receive({
		t: 'yjs',
		room: room.room,
		gen: 'g1',
		b64: toBase64(encoding.toUint8Array(encoder))
	});
	return { room, server, sent };
}

test('typing in the editor lands in the shared text as your own undoable edit', () => {
	const { room } = syncedRoom('hello\nworld\n');
	const model = new FakeModel('hello\nworld\n');
	const binding = new TextBinding(room, model);
	model.type(5, 0, ' there');
	model.type(0, 1, 'H');
	assert.equal(room.text.toString(), 'Hello there\nworld\n');
	room.undo.undo();
	assert.equal(model.getValue(), 'hello\nworld\n');
	binding.dispose();
	room.destroy();
});

test('remote edits reach the editor as small edits, not a full replace', () => {
	const { room } = syncedRoom('a\nb\nc\n');
	const model = new FakeModel('a\nb\nc\n');
	const binding = new TextBinding(room, model);
	const remote = new Y.Doc();
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(room.doc));
	const before = Y.encodeStateVector(remote);
	remote.getText('content').insert(2, 'B');
	remote.getText('content').delete(0, 1);
	Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(remote, before), REMOTE_ORIGIN);
	assert.equal(model.getValue(), '\nBb\nc\n');
	assert.ok(model.edits <= 2);
	room.undo.undo();
	assert.equal(model.getValue(), '\nBb\nc\n');
	binding.dispose();
	room.destroy();
});

test('binding to a stale editor buffer patches only the difference', () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join('');
	const { room } = syncedRoom(lines.replace('line 50', 'line fifty'));
	const model = new FakeModel(lines);
	const binding = new TextBinding(room, model);
	assert.equal(model.getValue(), room.text.toString());
	assert.equal(model.edits, 1);
	binding.dispose();
	room.destroy();
});

test('the editor waits for a fresh doc to sync before it follows it', () => {
	const sent: YFrame[] = [];
	const { room, server } = syncedRoom('keep me\n', sent);
	const model = new FakeModel('keep me\n');
	const binding = new TextBinding(room, model);
	room.receive({ t: 'yjs-reset', room: room.room, gen: 'g2' });
	assert.equal(binding.waiting, true);
	assert.equal(model.getValue(), 'keep me\n');
	model.type(0, 0, 'x');
	assert.equal(room.text.toString(), '');
	const encoder = encoding.createEncoder();
	syncProtocol.writeSyncStep2(encoder, server, Y.encodeStateVector(room.doc));
	room.receive({
		t: 'yjs',
		room: room.room,
		gen: 'g2',
		b64: toBase64(encoding.toUint8Array(encoder))
	});
	assert.equal(binding.waiting, false);
	assert.equal(model.getValue(), 'keep me\n');
	binding.dispose();
	room.destroy();
});

test('files with Windows line endings are not shared', () => {
	const model = new FakeModel('a\r\nb');
	model.eol = '\r\n';
	assert.equal(TextBinding.supports(model), false);
	assert.equal(TextBinding.supports(new FakeModel('a\nb')), true);
});

test('sync status reads honestly through a drop and back', () => {
	const sent: YFrame[] = [];
	const room = new YjsRoom('file:s:a.ts', (frame) => (sent.push(frame), true), { canWrite: true });
	rooms.push(room);
	assert.equal(room.status, 'connecting');
	room.connect();
	assert.equal(room.status, 'syncing');
	const server = new Y.Doc();
	const encoder = encoding.createEncoder();
	syncProtocol.writeSyncStep2(encoder, server, Y.encodeStateVector(room.doc));
	room.receive({
		t: 'yjs',
		room: room.room,
		gen: 'g',
		b64: toBase64(encoding.toUint8Array(encoder))
	});
	assert.equal(room.status, 'synced');
	room.doc.transact(() => room.text.insert(0, 'hi'), room.local);
	assert.equal(room.status, 'syncing');
	const update = sent.findLast((f) => f.t === 'yjs' && typeof f.n === 'number');
	room.receive({ t: 'yjs-ack', room: room.room, n: update?.n });
	assert.equal(room.status, 'synced');
	room.disconnect();
	assert.equal(room.status, 'reconnecting');
	room.doc.transact(() => room.text.insert(0, 'offline '), room.local);
	assert.equal(room.status, 'offline');
	room.destroy();
});

test('your own text merge keeps both sides and never doubles a shared change', () => {
	assert.equal(mergeText('x\ny\n', 'x\ny\nmine\n', 'top\nx\ny\n'), 'top\nx\ny\nmine\n');
	assert.equal(mergeText('x\n', 'x\nsame\n', 'x\nsame\n'), 'x\nsame\n');
});
