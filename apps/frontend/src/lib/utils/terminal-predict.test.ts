import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { GhosttyCore } from '@wterm/ghostty';
import { PredictiveEcho, type PredictTarget } from './terminal-predict';

class FakeTerm implements PredictTarget {
	cols: number;
	rows: number;
	grid: string[][];
	x = 0;
	y = 0;
	viewportY = 0;
	mouse = false;
	alt = false;
	writes: string[] = [];
	overlay: { row: number; x: number; text: string; cursor: number } | null = null;
	overlayShows = 0;
	onWrite: ((s: string) => void) | null = null;

	constructor(cols = 40, rows = 5) {
		this.cols = cols;
		this.rows = rows;
		this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
	}

	cursor() {
		return { x: this.x, y: this.y };
	}

	cellAt(row: number, col: number) {
		return this.grid[row]?.[col] ?? ' ';
	}

	isAlternate() {
		return this.alt;
	}

	mouseTracking() {
		return this.mouse;
	}

	scrolledBack() {
		return this.viewportY !== 0;
	}

	showOverlay(row: number, x: number, text: string, cursor: number) {
		this.overlayShows += 1;
		this.overlay = { row, x, text, cursor };
	}

	hideOverlay() {
		this.overlay = null;
	}

	row(y = this.y) {
		return this.grid[y].join('').replace(/\s+$/, '');
	}

	shown(y = this.y) {
		const cells = [...this.grid[y]];
		if (this.overlay && this.overlay.row === y) {
			for (let i = 0; i < this.overlay.text.length; i++) {
				cells[this.overlay.x + i] = this.overlay.text[i];
			}
		}
		return cells.join('').replace(/\s+$/, '');
	}

	write(s: string, done: () => void) {
		this.writes.push(s);
		this.onWrite?.(s);
		let i = 0;
		while (i < s.length) {
			const ch = s[i];
			if (ch === '\x1b' && s[i + 1] === '[') {
				let j = i + 2;
				while (j < s.length && !/[A-Za-z]/.test(s[j])) j++;
				const params = s.slice(i + 2, j);
				const final = s[j];
				this.csi(params, final);
				i = j + 1;
				continue;
			}
			if (ch === '\r') this.x = 0;
			else if (ch === '\n') this.y = Math.min(this.rows - 1, this.y + 1);
			else if (ch === '\b') this.x = Math.max(0, this.x - 1);
			else if (ch >= ' ') {
				if (this.x < this.cols) {
					this.grid[this.y][this.x] = ch;
					this.x += 1;
				}
			}
			i += 1;
		}
		done();
	}

	private csi(params: string, final: string) {
		const n = params.startsWith('?') ? 0 : parseInt(params || '1', 10) || 1;
		switch (final) {
			case 'D':
				this.x = Math.max(0, this.x - n);
				break;
			case 'C':
				this.x = Math.min(this.cols - 1, this.x + n);
				break;
			case 'K':
				for (let c = params === '2' ? 0 : this.x; c < this.cols; c++) {
					this.grid[this.y][c] = ' ';
				}
				break;
			case 'H':
				this.x = 0;
				this.y = 0;
				break;
			case 'h':
			case 'l':
				if (params === '?1049') this.alt = final === 'h';
				break;
			default:
				break;
		}
	}
}

function key(k: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		type: 'keydown',
		key: k,
		code: '',
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false,
		keyCode: 0,
		...extra
	} as KeyboardEvent;
}

function mk(opts: { minRttMs?: number; floor?: number; ceil?: number } = {}) {
	const t = new FakeTerm();
	let now = 1000;
	const clock = {
		get now() {
			return now;
		},
		advance(ms: number) {
			now += ms;
		}
	};
	const p = new PredictiveEcho(t, {
		now: () => now,
		minRttMs: opts.minRttMs ?? 40,
		timeoutFloorMs: opts.floor ?? 150,
		timeoutCeilMs: opts.ceil ?? 600
	});
	t.write('$ ', () => {});
	return { p, t, clock };
}

function type(p: PredictiveEcho, ch: string) {
	p.noteKeyDown(key(ch === '\x7f' ? 'Backspace' : ch));
	p.onUserData(ch);
}

function activate(p: PredictiveEcho, t: FakeTerm, clock: { advance(ms: number): void }) {
	type(p, 'a');
	clock.advance(80);
	p.applyRemote('a');
	type(p, 'b');
	clock.advance(80);
	p.applyRemote('b');
	assert.equal(p.state, 'active');
	assert.equal(t.row(), '$ ab');
}

test('the very first keystroke is drawn without any warmup', () => {
	const { p, t } = mk();
	type(p, 'a');
	assert.equal(p.state, 'active');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.row(), '$');
	assert.equal(t.shown(), '$ a');
	assert.equal(t.x, 2);
});

test('a fast link measures itself and stops drawing', () => {
	const { p, t, clock } = mk();
	for (const ch of 'hel') {
		type(p, ch);
		clock.advance(5);
		p.applyRemote(ch);
	}
	assert.equal(p.state, 'shadow');
	const shows = t.overlayShows;
	for (const ch of 'lo') {
		type(p, ch);
		clock.advance(5);
		p.applyRemote(ch);
	}
	assert.equal(t.overlayShows, shows);
	assert.equal(p.metrics.confirms, 5);
	assert.equal(t.row(), '$ hello');
});

test('active shows the glyph as an overlay at the cursor without touching the buffer', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	assert.equal(t.row(), '$ ab');
	assert.equal(t.shown(), '$ abA');
	assert.deepEqual(t.overlay, { row: 0, x: 4, text: 'A ', cursor: 1 });
	assert.equal(t.x, 4);
});

test('the real echo confirms and clears the underline', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	clock.advance(80);
	p.applyRemote('A');
	assert.equal(t.row(), '$ abA');
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.confirms, 3);
});

test('two predictions confirmed by one chunk', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	assert.equal(t.shown(), '$ abAB');
	assert.equal(t.row(), '$ ab');
	clock.advance(80);
	p.applyRemote('AB');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ abAB');
	assert.equal(t.overlay, null);
});

test('a partial echo confirms the prefix and redraws the rest', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	clock.advance(80);
	p.applyRemote('A');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.row(), '$ abA');
	assert.equal(t.shown(), '$ abAB');
	assert.deepEqual(t.overlay, { row: 0, x: 5, text: 'B ', cursor: 1 });
	assert.equal(t.x, 5);
});

test('one mismatched echo retracts but keeps predicting', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	clock.advance(80);
	p.applyRemote('X');
	assert.equal(t.row(), '$ abX');
	assert.equal(t.overlay, null);
	assert.equal(p.state, 'active');
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.retracts, 1);
	type(p, 'B');
	assert.equal(t.shown(), '$ abXB');
});

test('two misses in a row demote to shadow and one confirm brings it back', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	clock.advance(80);
	p.applyRemote('X');
	type(p, 'B');
	clock.advance(80);
	p.applyRemote('Y');
	assert.equal(p.state, 'shadow');
	type(p, 'C');
	assert.equal(t.overlay, null);
	clock.advance(80);
	p.applyRemote('C');
	assert.equal(p.state, 'active');
	type(p, 'D');
	assert.equal(t.shown(), '$ abXYCD');
});

test('an echo later than the round trip but inside the timeout still confirms', async () => {
	const { p, t, clock } = mk({ floor: 500, ceil: 2000 });
	for (const ch of 'ab') {
		type(p, ch);
		clock.advance(190);
		p.applyRemote(ch);
	}
	type(p, 'c');
	await new Promise((r) => setTimeout(r, 20));
	clock.advance(450);
	assert.equal(t.shown(), '$ abc');
	p.applyRemote('c');
	assert.equal(p.metrics.retracts, 0);
	assert.equal(t.row(), '$ abc');
});

test('an unconfirmed prediction times out and retracts without demoting', async () => {
	const { p, t, clock } = mk({ floor: 1, ceil: 1 });
	activate(p, t, clock);
	type(p, 'A');
	assert.equal(t.shown(), '$ abA');
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(t.shown(), '$ ab');
	assert.equal(t.overlay, null);
	assert.equal(t.x, 4);
	assert.equal(p.state, 'active');
	assert.equal(p.metrics.pending, 0);
});

test('backspace nets out a pending insert and both confirm together', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, '\x7f');
	assert.equal(t.shown(), '$ ab');
	assert.equal(t.overlay, null);
	assert.equal(t.x, 4);
	assert.equal(p.metrics.pending, 2);
	clock.advance(80);
	p.applyRemote('A\b \b');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
	assert.equal(p.state, 'active');
});

test('backspace over already echoed input is predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.row(), '$ ab');
	assert.equal(t.shown(), '$ a');
	assert.deepEqual(t.overlay, { row: 0, x: 3, text: '  ', cursor: 0 });
	clock.advance(80);
	p.applyRemote('\b \b');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	assert.equal(t.row(), '$ a');
});

test('backspace never predicts into the prompt', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, '\x7f');
	type(p, '\x7f');
	assert.equal(t.shown(), '$');
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 2);
	assert.equal(t.shown(), '$');
});

test('backspace in the middle of a line waits for the shell', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.noteKeyDown(key('ArrowLeft'));
	p.onUserData('\x1b[D');
	clock.advance(80);
	p.applyRemote('\b');
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
});

test('enter keeps pending predictions on screen until the shell answers', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'l');
	type(p, 's');
	p.noteKeyDown(key('Enter'));
	p.onUserData('\r');
	assert.equal(t.shown(), '$ abls');
	clock.advance(80);
	p.applyRemote('ls\r\nfile\r\n$ ');
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.retracts, 0);
	assert.equal(t.overlay, null);
	assert.equal(p.state, 'active');
});

test('typing right after enter waits for the next prompt, then predicts again', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.noteKeyDown(key('Enter'));
	p.onUserData('\r');
	type(p, 'x');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	clock.advance(80);
	p.applyRemote('\r\n$ x');
	type(p, 'y');
	assert.equal(t.shown(), '$ xy');
});

test('control keys are never predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.noteKeyDown(key('ArrowLeft'));
	p.onUserData('\x1b[D');
	p.noteKeyDown(key('c', { ctrlKey: true }));
	p.onUserData('\x03');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
});

test('a bare shift press between letters keeps the predictions', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'x');
	p.noteKeyDown(key('Shift', { shiftKey: true }));
	type(p, 'Y');
	assert.equal(p.metrics.pending, 2);
	assert.equal(t.shown(), '$ abxY');
});

test('pasted text without a keydown token is not predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.onUserData('abc');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
});

test('an IME commit without a keydown token is not predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.onUserData('a');
	assert.equal(p.metrics.pending, 0);
});

test('alternate screen blocks prediction and flushes mid-burst', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	t.alt = true;
	type(p, 'A');
	assert.equal(p.metrics.pending, 0);
	t.alt = false;
	clock.advance(100);
	p.applyRemote('A');
	type(p, 'A');
	assert.equal(p.metrics.pending, 1);
	p.applyRemote('\x1b[?1049h');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.alt, true);
});

test('mouse reporting, which tmux turns on with mouse on, blocks every prediction', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	t.mouse = true;
	type(p, 'A');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
});

test('a tmux echo wrapped in cursor hide and sync markers still confirms', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	clock.advance(150);
	p.applyRemote('\x1b[?2026h\x1b[?25lA\x1b[?25h\x1b[?2026l');
	p.applyRemote('\x1b[?25lB\x1b[?25h');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ abAB');
	assert.equal(p.state, 'active');
});

test('the last column is never predicted into', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	t.x = t.cols - 1;
	type(p, 'A');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
});

test('one spare column is always left before the margin', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	t.x = t.cols - 2;
	type(p, 'A');
	assert.equal(p.metrics.pending, 1);
	type(p, 'B');
	assert.equal(t.overlay?.text, 'A ');
	assert.equal(t.x, t.cols - 2);
});

test('scrolled back into history blocks prediction', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	t.viewportY = 3;
	type(p, 'A');
	assert.equal(p.metrics.pending, 0);
});

test('a password prompt suppresses prediction until the next newline', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	p.applyRemote('\r\nPassword: ');
	type(p, 'x');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), 'Password:');
	clock.advance(100);
	p.applyRemote('\r\n$ ');
	type(p, 'y');
	assert.equal(p.metrics.pending, 1);
});

test('a whole-line repaint still confirms', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'c');
	type(p, 'd');
	clock.advance(80);
	p.applyRemote('\r$ abcd\x1b[K');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ abcd');
	assert.equal(p.state, 'active');
});

test('input arriving re-entrantly during a remote write is ignored', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	t.onWrite = () => {
		p.onUserData('Z');
	};
	clock.advance(80);
	p.applyRemote('A');
	t.onWrite = null;
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ abA');
});

test('a disconnect flush restores the screen and clears the queue', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	assert.equal(t.shown(), '$ abAB');
	p.flush('disconnect');
	assert.equal(t.shown(), '$ ab');
	assert.equal(t.overlay, null);
	assert.equal(t.x, 4);
	assert.equal(p.metrics.pending, 0);
});

test('the kill switch disables drawing', () => {
	const t = new FakeTerm();
	let enabled = true;
	let now = 0;
	const p = new PredictiveEcho(t, { now: () => now, enabled: () => enabled });
	t.write('$ ', () => {});
	type(p, 'a');
	now += 80;
	p.applyRemote('a');
	type(p, 'b');
	now += 80;
	p.applyRemote('b');
	assert.equal(p.state, 'active');
	enabled = false;
	type(p, 'A');
	assert.equal(p.state, 'disabled');
	assert.equal(t.row(), '$ ab');
	assert.equal(t.overlay, null);
});

test('a sealed line confirms piece by piece as the echo trickles in', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'l');
	type(p, 's');
	p.noteKeyDown(key('Enter'));
	p.onUserData('\r');
	clock.advance(80);
	p.applyRemote('l');
	assert.equal(t.shown(), '$ abls');
	p.applyRemote('s\r\n$ ');
	assert.equal(p.metrics.retracts, 0);
	assert.equal(t.overlay, null);
});

test('a sealed line the shell never echoes is retracted quietly', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'x');
	type(p, 'y');
	p.noteKeyDown(key('u', { ctrlKey: true }));
	p.onUserData('\x15');
	clock.advance(80);
	p.applyRemote('\r$ ab\x1b[K');
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.state, 'active');
});

const require = createRequire(import.meta.url);
const ghosttyWasm = URL.createObjectURL(
	new Blob([readFileSync(require.resolve('@wterm/ghostty/ghostty-vt.wasm'))], {
		type: 'application/wasm'
	})
);

class VtTerm implements PredictTarget {
	overlay: { row: number; x: number; text: string; cursor: number } | null = null;
	failWrites = false;

	private constructor(
		readonly core: GhosttyCore,
		readonly cols: number,
		readonly rows: number
	) {}

	static async create(cols = 38, rows = 14) {
		const core = await GhosttyCore.load({ wasmPath: ghosttyWasm });
		core.init(cols, rows);
		return new VtTerm(core, cols, rows);
	}

	cursor() {
		const c = this.core.getCursor();
		return { x: c.col, y: c.row };
	}

	cellAt(row: number, col: number) {
		const cell = this.core.getCell(row, col);
		if (cell.width === 0) return '\u0000';
		if (cell.chars) return cell.chars;
		return cell.char > 0 ? String.fromCodePoint(cell.char) : ' ';
	}

	isAlternate() {
		return this.core.usingAltScreen();
	}

	mouseTracking() {
		return this.core.mouseTracking() !== 0;
	}

	scrolledBack() {
		return false;
	}

	feed(data: string) {
		this.core.writeString(data);
	}

	write(data: string, done: () => void) {
		this.core.writeString(data);
		if (this.failWrites) throw new Error('delivery failed');
		done();
	}

	showOverlay(row: number, x: number, text: string, cursor: number) {
		this.overlay = { row, x, text, cursor };
	}

	hideOverlay() {
		this.overlay = null;
	}

	row(y: number) {
		let s = '';
		for (let c = 0; c < this.cols; c++) s += this.cellAt(y, c);
		return s.replace(/\s+$/, '');
	}

	shown(y: number) {
		const cells = Array.from({ length: this.cols }, (_, c) => this.cellAt(y, c));
		if (this.overlay && this.overlay.row === y) {
			for (let i = 0; i < this.overlay.text.length; i++) {
				cells[this.overlay.x + i] = this.overlay.text[i];
			}
		}
		return cells.join('').replace(/\s+$/, '');
	}

	screen() {
		return Array.from({ length: this.rows }, (_, y) => this.shown(y))
			.join('\n')
			.replace(/\n+$/, '');
	}
}

const PROMPT_PLAIN = 'dev@4b1ac006-af9:~/.worktrees/orchard-releases/hi-67b406$ ';
const PROMPT =
	'\x1b[32m\x1b[1mdev@4b1ac006-af9\x1b(B\x1b[m:\x1b[34m\x1b[1m~/.worktrees/orchard-releases/hi-67b406\x1b(B\x1b[m$ ';
const PROMPT_TAIL = 'releases/hi-67b406$';

async function vt(cols = 38, rows = 14) {
	const t = await VtTerm.create(cols, rows);
	let now = 1000;
	const clock = {
		advance(ms: number) {
			now += ms;
		}
	};
	const p = new PredictiveEcho(t, { now: () => now, timeoutFloorMs: 150, timeoutCeilMs: 600 });
	return { p, t, clock };
}

function typeAll(p: PredictiveEcho, text: string) {
	for (const ch of text) type(p, ch);
}

function enter(p: PredictiveEcho) {
	p.noteKeyDown(key('Enter'));
	p.onUserData('\r');
}

test('vt: the wrapped prompt really wraps at 38 columns', async () => {
	const { t } = await vt();
	t.feed(PROMPT);
	assert.equal(t.row(0), PROMPT_PLAIN.slice(0, 38));
	assert.equal(t.row(1), PROMPT_TAIL);
	assert.deepEqual(t.cursor(), { x: 20, y: 1 });
});

test('vt: clear under tmux on a wrapped prompt leaves nothing behind', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'clear');
	assert.deepEqual(t.overlay, { row: 1, x: 20, text: 'clear ', cursor: 5 });
	clock.advance(80);
	p.applyRemote('cle');
	assert.equal(t.shown(1), `${PROMPT_TAIL} clear`);
	enter(p);
	clock.advance(40);
	p.applyRemote('\x1b[?12l\x1b[?25h\x1b[2;24Har\r\n');
	p.applyRemote(`\x1b[3d\x1b[J\x1b[H\x1b[K${PROMPT}\x1b[K`);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.screen(), `${PROMPT_PLAIN.slice(0, 38)}\n${PROMPT_TAIL}`);
	assert.deepEqual(t.cursor(), { x: 20, y: 1 });
});

test('vt: clear typed blind and answered in one chunk leaves nothing behind', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'clear');
	enter(p);
	assert.equal(t.shown(1), `${PROMPT_TAIL} clear`);
	clock.advance(120);
	p.applyRemote(`clear\x1b[K\r\n\x1b[3d\x1b[J\x1b[H\x1b[K${PROMPT}\x1b[K`);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.screen(), `${PROMPT_PLAIN.slice(0, 38)}\n${PROMPT_TAIL}`);
});

test('vt: the captured tmux clear bytes leave nothing behind', async () => {
	const { p, t, clock } = await vt();
	const short = '\x1b[32m\x1b[1mdev@4b1ac006-af9\x1b(B\x1b[m:\x1b[34m\x1b[1m~\x1b(B\x1b[m$ ';
	t.feed(`\x1b[H${short}echo hello\x1b[K\r\nhello\x1b[K\x1b[32m\x1b[1m\r\n${short}`);
	assert.deepEqual(t.cursor(), { x: 20, y: 2 });
	typeAll(p, 'clear');
	clock.advance(80);
	p.applyRemote('cle');
	enter(p);
	p.applyRemote('\x1b[K\x1b[?12l\x1b[?25h\x1b[3;24Har\r\n');
	p.applyRemote(`\x1b[2d\x1b[J\x1b[H\x1b[K${short}`);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.screen(), 'dev@4b1ac006-af9:~$');
});

test('vt: an echo split across chunks confirms piece by piece', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'hello');
	clock.advance(80);
	p.applyRemote('\x1b[?25l\x1b[2;21Hh\x1b[?25h');
	assert.equal(p.metrics.pending, 4);
	assert.equal(t.shown(1), `${PROMPT_TAIL} hello`);
	p.applyRemote('\x1b[?25lel\x1b[?25h');
	assert.equal(p.metrics.pending, 2);
	assert.deepEqual(t.overlay, { row: 1, x: 23, text: 'lo ', cursor: 2 });
	p.applyRemote('lo\x1b[K');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	assert.equal(t.row(1), `${PROMPT_TAIL} hello`);
});

test('vt: typing never predicts across the wrap and picks up on the next row', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	const fill = 'abcdefghijklmnopq';
	typeAll(p, fill);
	assert.equal(p.metrics.pending, 17);
	assert.equal(t.overlay?.row, 1);
	assert.equal(t.overlay!.x + t.overlay!.text.length, 38);
	clock.advance(80);
	p.applyRemote(fill);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.deepEqual(t.cursor(), { x: 37, y: 1 });
	type(p, 'r');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	clock.advance(80);
	p.applyRemote('r');
	assert.deepEqual(t.cursor(), { x: 37, y: 1 });
	clock.advance(200);
	type(p, 's');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	clock.advance(80);
	p.applyRemote('s');
	assert.deepEqual(t.cursor(), { x: 1, y: 2 });
	clock.advance(200);
	type(p, 't');
	assert.deepEqual(t.overlay, { row: 2, x: 1, text: 't ', cursor: 1 });
	clock.advance(80);
	p.applyRemote('t');
	assert.equal(t.overlay, null);
	assert.equal(t.row(1), `${PROMPT_TAIL} abcdefghijklmnopqr`);
	assert.equal(t.row(2), 'st');
});

test('vt: a wrap on the bottom row scrolls and the next prediction lands on the new row', async () => {
	const { p, t, clock } = await vt(38, 4);
	t.feed(`\x1b[3;1H${PROMPT}`);
	assert.deepEqual(t.cursor(), { x: 20, y: 3 });
	typeAll(p, 'abcdefghijklmnopq');
	clock.advance(80);
	p.applyRemote('abcdefghijklmnopq');
	clock.advance(200);
	type(p, 'r');
	clock.advance(80);
	p.applyRemote('r');
	clock.advance(200);
	type(p, 's');
	clock.advance(80);
	p.applyRemote('s');
	assert.deepEqual(t.cursor(), { x: 1, y: 3 });
	assert.equal(t.row(2), `${PROMPT_TAIL} abcdefghijklmnopqr`);
	clock.advance(200);
	type(p, 't');
	assert.deepEqual(t.overlay, { row: 3, x: 1, text: 't ', cursor: 1 });
	type(p, '\x7f');
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 2);
	assert.equal(t.shown(3), 's');
	assert.equal(t.shown(2), `${PROMPT_TAIL} abcdefghijklmnopqr`);
});

test('vt: backspace on a wrapped continuation row never reaches back across the wrap', async () => {
	const { p, t, clock } = await vt();
	t.feed(`${PROMPT}abcdefghijklmnopqrstu`);
	assert.deepEqual(t.cursor(), { x: 3, y: 2 });
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	clock.advance(80);
	p.applyRemote('\b \b');
	type(p, 'X');
	assert.deepEqual(t.overlay, { row: 2, x: 2, text: 'X ', cursor: 1 });
	type(p, '\x7f');
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 2);
	assert.equal(t.shown(2), 'st');
});

test('vt: a stale input floor from an older prompt on the same row is not trusted', async () => {
	const { p, t, clock } = await vt(38, 4);
	t.feed('\x1b[4;1H$ ');
	type(p, 'a');
	clock.advance(80);
	p.applyRemote('a');
	assert.equal(t.row(3), '$ a');
	p.applyRemote('\r\n> longer prompt here: ');
	assert.deepEqual(t.cursor(), { x: 22, y: 3 });
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
});

for (const [name, bytes] of [
	['erase display', '\x1b[2J'],
	['full reset', '\x1bc'],
	['clear scrollback', '\x1b[3J'],
	['home and erase', '\x1b[H\x1b[2J'],
	['jump to another row', '\x1b[6;1H'],
	['vertical position', '\x1b[8d'],
	['erase the burst row', '\x1b[2K'],
	['scroll up', '\x1b[S']
] as const) {
	test(`vt: a sealed burst is retracted by ${name}`, async () => {
		const { p, t, clock } = await vt();
		t.feed(PROMPT);
		typeAll(p, 'ls');
		enter(p);
		assert.equal(t.shown(1), `${PROMPT_TAIL} ls`);
		clock.advance(80);
		p.applyRemote(bytes);
		assert.equal(t.overlay, null);
		assert.equal(p.metrics.pending, 0);
	});

	test(`vt: an unsealed burst is retracted by ${name}`, async () => {
		const { p, t, clock } = await vt();
		t.feed(PROMPT);
		typeAll(p, 'ls');
		assert.equal(t.shown(1), `${PROMPT_TAIL} ls`);
		clock.advance(80);
		p.applyRemote(bytes);
		assert.equal(t.overlay, null);
		assert.equal(p.metrics.pending, 0);
	});
}

test('vt: a burst whose row scrolled off the bottom is retracted', async () => {
	const { p, t, clock } = await vt(38, 4);
	t.feed('\x1b[4;1H$ ');
	typeAll(p, 'ab');
	clock.advance(80);
	p.applyRemote('\x1b7\n\x1b8');
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
});

test('vt: an identical prompt redraw that keeps the cursor keeps the prediction', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'ab');
	clock.advance(80);
	p.applyRemote(`\x1b[?25l\x1b[H${PROMPT}\x1b[?25h`);
	assert.equal(p.metrics.pending, 2);
	assert.equal(t.shown(1), `${PROMPT_TAIL} ab`);
});

test('vt: enter seals and the echo with its newline flushes the overlay', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'ls');
	enter(p);
	clock.advance(80);
	p.applyRemote('l');
	assert.equal(t.shown(1), `${PROMPT_TAIL} ls`);
	p.applyRemote('s\r\n');
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.retracts, 0);
});

test('vt: a sealed burst that never hears back times out and hides', async () => {
	const t = await VtTerm.create();
	let now = 1000;
	const p = new PredictiveEcho(t, { now: () => now, timeoutFloorMs: 1, timeoutCeilMs: 1 });
	t.feed(PROMPT);
	typeAll(p, 'ls');
	enter(p);
	assert.notEqual(t.overlay, null);
	now += 50;
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
});

test('vt: a terminal write that throws still takes the overlay down', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'ls');
	assert.notEqual(t.overlay, null);
	t.failWrites = true;
	clock.advance(80);
	p.applyRemote('\x1b[H\x1b[2J');
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
});

test('vt: a clear split mid escape sequence still retracts', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'ab');
	clock.advance(80);
	p.applyRemote('\x1b[?25l\x1b');
	assert.equal(p.metrics.pending, 2);
	p.applyRemote(`[2J\x1b[2;1H${PROMPT_TAIL} \x1b[?25h`);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.pending, 0);
});

test('vt: a predicted backspace confirms when the shell erases the cell', async () => {
	const { p, t, clock } = await vt();
	t.feed(PROMPT);
	typeAll(p, 'abc');
	clock.advance(80);
	p.applyRemote('abc');
	type(p, '\x7f');
	type(p, '\x7f');
	assert.equal(t.shown(1), `${PROMPT_TAIL} a`);
	clock.advance(80);
	p.applyRemote('\b \b');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.shown(1), `${PROMPT_TAIL} a`);
	p.applyRemote('\b\x1b[K');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.overlay, null);
	assert.equal(p.metrics.retracts, 0);
	assert.equal(p.metrics.confirms, 5);
	assert.equal(t.row(1), `${PROMPT_TAIL} a`);
});
