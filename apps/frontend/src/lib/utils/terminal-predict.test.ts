import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictiveEcho, type PredictTerminal } from './terminal-predict';

class FakeTerm implements PredictTerminal {
	cols: number;
	rows: number;
	grid: string[][];
	ul: boolean[][];
	x = 0;
	y = 0;
	viewportY = 0;
	mouse = false;
	alt = false;
	underline = false;
	writes: string[] = [];
	onWrite: ((s: string) => void) | null = null;

	constructor(cols = 40, rows = 5) {
		this.cols = cols;
		this.rows = rows;
		this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
		this.ul = Array.from({ length: rows }, () => Array(cols).fill(false));
	}

	wasmTerm = {
		getCursor: () => ({ x: this.x, y: this.y, visible: true }),
		getGraphemeString: (row: number, col: number) => this.grid[row]?.[col] ?? ' ',
		isAlternateScreen: () => this.alt
	};

	getViewportY() {
		return this.viewportY;
	}

	hasMouseTracking() {
		return this.mouse;
	}

	row(y = this.y) {
		return this.grid[y].join('').replace(/\s+$/, '');
	}

	write(s: string) {
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
					this.ul[this.y][this.x] = this.underline;
					this.x += 1;
				}
			}
			i += 1;
		}
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
					this.ul[this.y][c] = false;
				}
				break;
			case 'H':
				this.x = 0;
				this.y = 0;
				break;
			case 'm':
				for (const p of params.split(';')) {
					if (p === '4') this.underline = true;
					else if (p === '24' || p === '0' || p === '') this.underline = false;
				}
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
	t.write('$ ');
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

test('shadow mode tracks but draws nothing', () => {
	const { p, t } = mk();
	type(p, 'a');
	assert.equal(p.state, 'shadow');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.row(), '$');
	assert.equal(t.x, 2);
});

test('a fast link never leaves shadow', () => {
	const { p, t, clock } = mk();
	for (const ch of 'hello') {
		type(p, ch);
		clock.advance(5);
		p.applyRemote(ch);
	}
	assert.equal(p.state, 'shadow');
	assert.equal(p.metrics.confirms, 5);
	assert.equal(t.row(), '$ hello');
	assert.ok(t.writes.every((w) => !w.includes('\x1b[4m')));
});

test('active draws the glyph underlined at the cursor', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	assert.equal(t.row(), '$ abA');
	assert.equal(t.ul[0][4], true);
	assert.equal(t.x, 5);
	assert.equal(t.underline, false);
});

test('the real echo confirms and clears the underline', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	clock.advance(80);
	p.applyRemote('A');
	assert.equal(t.row(), '$ abA');
	assert.equal(t.ul[0][4], false);
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.confirms, 3);
});

test('two predictions confirmed by one chunk', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	assert.equal(t.row(), '$ abAB');
	clock.advance(80);
	p.applyRemote('AB');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ abAB');
	assert.equal(t.ul[0][4], false);
	assert.equal(t.ul[0][5], false);
});

test('a partial echo confirms the prefix and redraws the rest', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, 'B');
	clock.advance(80);
	p.applyRemote('A');
	assert.equal(p.metrics.pending, 1);
	assert.equal(t.row(), '$ abAB');
	assert.equal(t.ul[0][4], false);
	assert.equal(t.ul[0][5], true);
	assert.equal(t.x, 6);
});

test('a mismatched echo retracts and demotes to shadow', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	clock.advance(80);
	p.applyRemote('X');
	assert.equal(t.row(), '$ abX');
	assert.equal(t.ul[0][4], false);
	assert.equal(p.state, 'shadow');
	assert.equal(p.metrics.pending, 0);
	assert.equal(p.metrics.retracts, 1);
});

test('an unconfirmed prediction times out, retracts and demotes', async () => {
	const { p, t, clock } = mk({ floor: 1, ceil: 1 });
	activate(p, t, clock);
	type(p, 'A');
	assert.equal(t.row(), '$ abA');
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(t.row(), '$ ab');
	assert.equal(t.x, 4);
	assert.equal(p.state, 'shadow');
	assert.equal(p.metrics.pending, 0);
});

test('backspace nets out a pending insert and both confirm together', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	type(p, '\x7f');
	assert.equal(t.row(), '$ ab');
	assert.equal(t.x, 4);
	assert.equal(p.metrics.pending, 2);
	clock.advance(80);
	p.applyRemote('A\b \b');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
	assert.equal(p.state, 'active');
});

test('backspace at the anchor is never predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, '\x7f');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
});

test('control keys flush and are never predicted', () => {
	const { p, t, clock } = mk();
	activate(p, t, clock);
	type(p, 'A');
	p.noteKeyDown(key('Enter'));
	p.onUserData('\r');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.row(), '$ ab');
	p.noteKeyDown(key('ArrowLeft'));
	p.onUserData('\x1b[D');
	p.noteKeyDown(key('c', { ctrlKey: true }));
	p.onUserData('\x03');
	assert.equal(p.metrics.pending, 0);
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
	type(p, 'A');
	assert.equal(p.metrics.pending, 1);
	p.applyRemote('\x1b[?1049h');
	assert.equal(p.metrics.pending, 0);
	assert.equal(t.alt, true);
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
	assert.equal(p.metrics.pending, 0);
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
	assert.equal(t.row(), '$ abAB');
	p.flush('disconnect');
	assert.equal(t.row(), '$ ab');
	assert.equal(t.x, 4);
	assert.equal(t.ul[0][4], false);
	assert.equal(p.metrics.pending, 0);
});

test('the kill switch disables drawing', () => {
	const t = new FakeTerm();
	let enabled = true;
	let now = 0;
	const p = new PredictiveEcho(t, { now: () => now, enabled: () => enabled });
	t.write('$ ');
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
});
