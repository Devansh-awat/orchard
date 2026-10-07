export type PredictState = 'disabled' | 'shadow' | 'active';

export type FlushReason =
	| 'nonprintable'
	| 'paste'
	| 'ime'
	| 'resize'
	| 'disconnect'
	| 'mismatch'
	| 'timeout'
	| 'altscreen'
	| 'guard';

export interface PredictTarget {
	readonly cols: number;
	cursor(): { x: number; y: number };
	cellAt(row: number, col: number): string;
	isAlternate(): boolean;
	mouseTracking(): boolean;
	scrolledBack(): boolean;
	write(data: string, done: () => void): void;
	showOverlay(row: number, x: number, text: string): void;
	hideOverlay(): void;
}

export interface PredictiveEchoOptions {
	enabled?: () => boolean;
	minRttMs?: number;
	confirmsToEnable?: number;
	timeoutFloorMs?: number;
	timeoutCeilMs?: number;
	now?: () => number;
	onStateChange?: (state: PredictState) => void;
}

export interface PredictMetrics {
	rttMs: number;
	pending: number;
	confirms: number;
	retracts: number;
}

type Op = { ins: string } | { del: true };

interface Burst {
	row: number;
	baseX: number;
	anchorX: number;
	ops: Op[];
	sentAt: number[];
}

interface Token {
	data: string;
	at: number;
}

const TOKEN_MAX_AGE_MS = 8;
const MAX_PENDING = 24;
const TAIL_BYTES = 160;
const PASSWORD_SUPPRESS_MS = 10_000;
const PASSWORD_RE =
	/(password|passphrase|passcode|pin|verification code)\s*(for [^\n]{0,60})?[:：]?\s*$/i;
const ESC = String.fromCharCode(0x1b);
const ALT_OR_MOUSE_RE = new RegExp(`${ESC}\\[\\?(?:1049|1047|47|100[0-6]|1015)[hl]`);

function netOf(ops: Op[], m = ops.length): number {
	let n = 0;
	for (let i = 0; i < m; i++) n += 'del' in ops[i] ? -1 : 1;
	return n;
}

function replay(ops: Op[], m = ops.length): string[] {
	const out: string[] = [];
	for (let i = 0; i < m; i++) {
		const op = ops[i];
		if ('del' in op) out.pop();
		else out.push(op.ins);
	}
	return out;
}

function simulate(baseX: number, ops: Op[], m: number): Map<number, string> {
	const cells = new Map<number, string>();
	let pos = baseX;
	for (let i = 0; i < m; i++) {
		const op = ops[i];
		if ('del' in op) {
			pos -= 1;
			cells.set(pos, ' ');
		} else {
			cells.set(pos, op.ins);
			pos += 1;
		}
	}
	return cells;
}

export class PredictiveEcho {
	private term: PredictTarget | null;
	private readonly enabled: () => boolean;
	private readonly minRttMs: number;
	private readonly confirmsToEnable: number;
	private readonly timeoutFloorMs: number;
	private readonly timeoutCeilMs: number;
	private readonly now: () => number;
	private readonly onStateChange?: (state: PredictState) => void;

	private _state: PredictState = 'shadow';
	private streak = 0;
	private rttEwma = 0;
	private token: Token | null = null;
	private burst: Burst | null = null;
	private suppressUntil = 0;
	private tail = '';
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inApply = false;
	private confirms = 0;
	private retracts = 0;

	constructor(term: PredictTarget, opts: PredictiveEchoOptions = {}) {
		this.term = term;
		this.enabled = opts.enabled ?? (() => true);
		this.minRttMs = opts.minRttMs ?? 40;
		this.confirmsToEnable = opts.confirmsToEnable ?? 2;
		this.timeoutFloorMs = opts.timeoutFloorMs ?? 150;
		this.timeoutCeilMs = opts.timeoutCeilMs ?? 600;
		this.now = opts.now ?? (() => Date.now());
		this.onStateChange = opts.onStateChange;
	}

	get state(): PredictState {
		return this._state;
	}

	get metrics(): PredictMetrics {
		return {
			rttMs: this.rttEwma,
			pending: this.burst?.ops.length ?? 0,
			confirms: this.confirms,
			retracts: this.retracts
		};
	}

	noteKeyDown(event: KeyboardEvent): void {
		if (event.type !== 'keydown') return;
		this.token = null;
		if (event.isComposing || event.keyCode === 229) return;
		const mod =
			(event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey) || event.metaKey;
		if (!mod && event.key.length === 1) {
			const c = event.key.charCodeAt(0);
			if (c >= 0x20 && c <= 0x7e) {
				this.token = { data: event.key, at: this.now() };
				return;
			}
		}
		if (!mod && event.key === 'Backspace') {
			this.token = { data: '\x7f', at: this.now() };
			return;
		}
		this.flush('nonprintable');
	}

	onUserData(data: string): void {
		if (this.inApply) return;
		const t = this.token;
		this.token = null;
		if (!t || t.data !== data || this.now() - t.at > TOKEN_MAX_AGE_MS) {
			this.flush(data.length === 1 ? 'ime' : 'paste');
			return;
		}
		if (data === '\x7f') this.pushDelete();
		else this.pushInsert(data);
	}

	applyRemote(data: string): void {
		const term = this.term;
		if (!term) return;
		const leavingLineMode = this.scanTail(data);
		this.inApply = true;
		try {
			term.write(data, () => {
				if (this.term !== term) return;
				this.inApply = true;
				try {
					if (leavingLineMode) {
						this.flush('altscreen');
						return;
					}
					if (this.burst) this.validate();
				} finally {
					this.inApply = false;
				}
			});
		} catch {
			this.disable();
		} finally {
			this.inApply = false;
		}
	}

	flush(reason: FlushReason): void {
		const burst = this.burst;
		if (burst && burst.ops.length > 0) this.retracts += 1;
		this.hideOverlay();
		this.endBurst();
		if (reason === 'disconnect') {
			this.streak = 0;
			this.token = null;
			this.tail = '';
		}
	}

	dispose(): void {
		this.clearTimer();
		this.hideOverlay();
		this.burst = null;
		this.token = null;
		this.term = null;
		this.setState('disabled');
	}

	private setState(next: PredictState): void {
		if (this._state === next) return;
		this._state = next;
		this.onStateChange?.(next);
	}

	private hideOverlay(): void {
		try {
			this.term?.hideOverlay();
		} catch {
			this.disable();
		}
	}

	private disable(): void {
		this.clearTimer();
		this.burst = null;
		this.setState('disabled');
	}

	private canPredict(): boolean {
		const term = this.term;
		if (!term) return false;
		if (!this.enabled()) {
			this.setState('disabled');
			return false;
		}
		if (this._state === 'disabled') this.setState('shadow');
		if (term.isAlternate()) return false;
		if (term.mouseTracking()) return false;
		if (term.scrolledBack()) return false;
		if (this.now() < this.suppressUntil) return false;
		return true;
	}

	private pushInsert(ch: string): void {
		const term = this.term;
		if (!term || !this.canPredict()) {
			this.flush('guard');
			return;
		}
		const cur = term.cursor();
		let burst = this.burst;
		if (burst && burst.row !== cur.y) {
			this.flush('mismatch');
			burst = null;
		}
		if (!burst) {
			burst = { row: cur.y, baseX: cur.x, anchorX: cur.x, ops: [], sentAt: [] };
			this.burst = burst;
		}
		if (burst.ops.length >= MAX_PENDING) {
			this.flush('guard');
			return;
		}
		const target = burst.baseX + netOf(burst.ops);
		if (target >= term.cols - 1) {
			this.flush('guard');
			return;
		}
		if (term.cellAt(burst.row, target) !== ' ') {
			this.flush('guard');
			return;
		}
		burst.ops.push({ ins: ch });
		burst.sentAt.push(this.now());
		this.redraw();
		this.armTimer();
	}

	private pushDelete(): void {
		const burst = this.burst;
		if (!burst || burst.baseX + netOf(burst.ops) <= burst.anchorX) {
			this.flush('nonprintable');
			return;
		}
		burst.ops.push({ del: true });
		burst.sentAt.push(this.now());
		this.redraw();
		this.armTimer();
	}

	private redraw(): void {
		const burst = this.burst;
		const term = this.term;
		if (!burst || !term) return;
		if (this._state !== 'active') {
			this.hideOverlay();
			return;
		}
		const glyphs = replay(burst.ops);
		if (glyphs.length === 0) {
			this.hideOverlay();
			return;
		}
		try {
			term.showOverlay(burst.row, burst.baseX, glyphs.join(''));
		} catch {
			this.disable();
		}
	}

	private validate(): void {
		const term = this.term;
		const burst = this.burst;
		if (!term || !burst) return;
		const cur = term.cursor();
		if (cur.y !== burst.row) {
			this.fail();
			return;
		}
		const k = cur.x - burst.baseX;
		let best = -1;
		for (let m = 0; m <= burst.ops.length; m++) {
			if (netOf(burst.ops, m) !== k) continue;
			if (this.cellsMatch(burst, m)) best = m;
		}
		if (best < 0) {
			this.fail();
			return;
		}
		if (best === 0) {
			this.redraw();
			this.armTimer();
			return;
		}
		const now = this.now();
		for (let i = 0; i < best; i++) {
			this.recordRtt(now - burst.sentAt[i]);
			this.streak += 1;
			this.confirms += 1;
		}
		burst.baseX += k;
		burst.ops.splice(0, best);
		burst.sentAt.splice(0, best);
		if (
			this._state === 'shadow' &&
			this.streak >= this.confirmsToEnable &&
			this.rttEwma > this.minRttMs
		) {
			this.setState('active');
		}
		if (burst.ops.length === 0) {
			this.hideOverlay();
			this.endBurst();
		} else {
			this.redraw();
			this.armTimer();
		}
	}

	private cellsMatch(burst: Burst, m: number): boolean {
		const term = this.term;
		if (!term) return false;
		for (const [x, ch] of simulate(burst.baseX, burst.ops, m)) {
			if (x < 0 || x >= term.cols) return false;
			if (term.cellAt(burst.row, x) !== ch) return false;
		}
		return true;
	}

	private fail(): void {
		this.streak = 0;
		if (this._state === 'active') this.setState('shadow');
		const burst = this.burst;
		if (burst && burst.ops.length > 0) this.retracts += 1;
		this.hideOverlay();
		this.endBurst();
	}

	private endBurst(): void {
		this.clearTimer();
		this.burst = null;
	}

	private recordRtt(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		this.rttEwma = this.rttEwma === 0 ? ms : this.rttEwma * 0.75 + ms * 0.25;
	}

	private timeoutMs(): number {
		const base = this.rttEwma > 0 ? this.rttEwma * 2 : this.timeoutCeilMs;
		return Math.max(this.timeoutFloorMs, Math.min(this.timeoutCeilMs, base));
	}

	private armTimer(): void {
		this.clearTimer();
		const burst = this.burst;
		if (!burst || burst.ops.length === 0) return;
		const due = burst.sentAt[0] + this.timeoutMs() - this.now();
		this.timer = setTimeout(
			() => {
				this.timer = null;
				this.fail();
			},
			Math.max(0, due)
		);
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private scanTail(data: string): boolean {
		this.tail = (this.tail + data).slice(-TAIL_BYTES);
		if (PASSWORD_RE.test(this.tail)) {
			this.suppressUntil = this.now() + PASSWORD_SUPPRESS_MS;
		} else if (data.includes('\n')) {
			this.suppressUntil = 0;
		}
		return ALT_OR_MOUSE_RE.test(data);
	}
}
