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
  showOverlay(row: number, x: number, text: string, cursor: number): void;
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
  sealed: boolean;
  prefix: string;
}

interface Token {
  data: string;
  at: number;
}

const TOKEN_MAX_AGE_MS = 8;
const MAX_PENDING = 24;
const MISSES_TO_SHADOW = 2;
const FAST_LINK_SAMPLES = 3;
const DELETE_LOOKAHEAD = 8;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn']);
const LINE_RESET_CHARS = ['\r', '\n', '\x03', '\x04', '\x0c'];
const TAIL_BYTES = 160;
const PASSWORD_SUPPRESS_MS = 10_000;
const PASSWORD_RE =
  /(password|passphrase|passcode|pin|verification code)\s*(for [^\n]{0,60})?[:：]?\s*$/i;
const ESC = String.fromCharCode(0x1b);
const ALT_OR_MOUSE_RE = new RegExp(`${ESC}\\[\\?(?:1049|1047|47|100[0-6]|1015)[hl]`);
const RESHAPE_RE = new RegExp(
  `[\\n\\v\\f]|${ESC}[cDEM]|${ESC}\\[\\??[0-9;]*[23]J|${ESC}\\[[0-9;]*[LMST]`
);
const PARTIAL_ESC_RE = new RegExp(`${ESC}(?:\\[[0-9;?]*)?$`);

function netOf(ops: Op[], m = ops.length): number {
  let n = 0;
  for (let i = 0; i < m; i++) n += 'del' in ops[i] ? -1 : 1;
  return n;
}

function lowestOf(baseX: number, ops: Op[]): number {
  let pos = baseX;
  let low = baseX;
  for (const op of ops) {
    pos += 'del' in op ? -1 : 1;
    low = Math.min(low, pos);
  }
  return low;
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

  private _state: PredictState = 'active';
  private streak = 0;
  private misses = 0;
  private rttEwma = 0;
  private rttSamples = 0;
  private token: Token | null = null;
  private burst: Burst | null = null;
  private suppressUntil = 0;
  private tail = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inApply = false;
  private confirms = 0;
  private retracts = 0;
  private inputRow = -1;
  private inputX: number | null = null;
  private inputPrefix = '';
  private carry = '';
  private reshaped = false;
  private blockedSince: number | null = null;
  private lastRemoteAt = 0;

  constructor(term: PredictTarget, opts: PredictiveEchoOptions = {}) {
    this.term = term;
    this.enabled = opts.enabled ?? (() => true);
    this.minRttMs = opts.minRttMs ?? 40;
    this.confirmsToEnable = opts.confirmsToEnable ?? 1;
    this.timeoutFloorMs = opts.timeoutFloorMs ?? 500;
    this.timeoutCeilMs = opts.timeoutCeilMs ?? 2000;
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
    if (MODIFIER_KEYS.has(event.key)) return;
    const mod =
      (event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey) || event.metaKey;
    if (mod) return;
    if (event.key.length === 1) {
      const c = event.key.charCodeAt(0);
      if (c >= 0x20 && c <= 0x7e) this.token = { data: event.key, at: this.now() };
      return;
    }
    if (event.key === 'Backspace') this.token = { data: '\x7f', at: this.now() };
  }

  onUserData(data: string): void {
    if (this.inApply) return;
    const t = this.token;
    this.token = null;
    if (!t || t.data !== data || this.now() - t.at > TOKEN_MAX_AGE_MS) {
      this.unpredicted(data);
      return;
    }
    if (data === '\x7f') this.pushDelete();
    else this.pushInsert(data);
  }

  applyRemote(data: string): void {
    const term = this.term;
    if (!term) return;
    this.lastRemoteAt = this.now();
    const scan = this.carry + data;
    this.carry = PARTIAL_ESC_RE.exec(scan)?.[0] ?? '';
    const leavingLineMode = this.scanTail(data, scan);
    const reshaped = RESHAPE_RE.test(scan);
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
          this.reshaped = reshaped;
          if (this.burst) this.validate();
        } finally {
          this.reshaped = false;
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
      this.carry = '';
      this.inputX = null;
      this.blockedSince = null;
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
    try {
      this.term?.hideOverlay();
    } catch {
      return;
    }
  }

  private fastLink(): boolean {
    return this.rttSamples >= FAST_LINK_SAMPLES && this.rttEwma < this.minRttMs;
  }

  private blocked(): boolean {
    if (this.blockedSince === null) return false;
    if (this.lastRemoteAt >= this.blockedSince + this.rttEwma * 0.8) {
      this.blockedSince = null;
      return false;
    }
    return true;
  }

  private canPredict(): boolean {
    const term = this.term;
    if (!term) return false;
    if (!this.enabled()) {
      this.setState('disabled');
      return false;
    }
    if (this._state === 'disabled') this.setState(this.fastLink() ? 'shadow' : 'active');
    if (term.isAlternate()) return false;
    if (term.mouseTracking()) return false;
    if (term.scrolledBack()) return false;
    if (this.now() < this.suppressUntil) return false;
    if (this.blocked()) return false;
    return true;
  }

  private unpredicted(data: string): void {
    const burst = this.burst;
    if (burst) {
      if (burst.ops.length > 0) burst.sealed = true;
      else this.endBurst();
    }
    this.blockedSince = this.now();
    if (LINE_RESET_CHARS.some((c) => data.includes(c))) this.inputX = null;
    if (this._state !== 'active') this.hideOverlay();
  }

  private predictedCell(burst: Burst | null, row: number, col: number): string {
    if (burst) {
      const cell = simulate(burst.baseX, burst.ops, burst.ops.length).get(col);
      if (cell !== undefined) return cell;
    }
    return this.term?.cellAt(row, col) ?? ' ';
  }

  private rowText(row: number, end: number): string {
    const term = this.term;
    if (!term) return '';
    let text = '';
    for (let c = 0; c < Math.min(end, term.cols); c++) text += term.cellAt(row, c);
    return text;
  }

  private inputFloor(row: number): number | null {
    const x = this.inputX;
    if (x === null || this.inputRow !== row) return null;
    if (this.rowText(row, x) === this.inputPrefix) return x;
    this.inputX = null;
    return null;
  }

  private openBurst(row: number, x: number): Burst {
    const burst: Burst = {
      row,
      baseX: x,
      anchorX: x,
      ops: [],
      sentAt: [],
      sealed: false,
      prefix: this.rowText(row, x)
    };
    this.burst = burst;
    if (this.inputFloor(row) === null) {
      this.inputRow = row;
      this.inputX = x;
      this.inputPrefix = burst.prefix;
    }
    return burst;
  }

  private pushInsert(ch: string): void {
    const term = this.term;
    if (!term || !this.canPredict()) {
      this.unpredicted(ch);
      return;
    }
    const cur = term.cursor();
    let burst = this.burst;
    if (burst && (burst.sealed || burst.row !== cur.y)) {
      this.flush('mismatch');
      burst = null;
    }
    const target = burst ? burst.baseX + netOf(burst.ops) : cur.x;
    if (
      (burst?.ops.length ?? 0) >= MAX_PENDING ||
      target >= term.cols - 1 ||
      this.predictedCell(burst, cur.y, target) !== ' '
    ) {
      this.unpredicted(ch);
      return;
    }
    burst ??= this.openBurst(cur.y, cur.x);
    burst.ops.push({ ins: ch });
    burst.sentAt.push(this.now());
    this.redraw();
    this.armTimer();
  }

  private pushDelete(): void {
    const term = this.term;
    if (!term || !this.canPredict()) {
      this.unpredicted('\x7f');
      return;
    }
    const cur = term.cursor();
    let burst = this.burst;
    if (burst && (burst.sealed || burst.row !== cur.y)) {
      this.flush('mismatch');
      burst = null;
    }
    const pos = burst ? burst.baseX + netOf(burst.ops) : cur.x;
    const floor = this.inputFloor(cur.y) ?? burst?.anchorX ?? null;
    let clear = floor !== null && pos > floor && (burst?.ops.length ?? 0) < MAX_PENDING;
    for (let c = pos; clear && c < Math.min(term.cols, pos + DELETE_LOOKAHEAD); c++) {
      if (this.predictedCell(burst, cur.y, c) !== ' ') clear = false;
    }
    if (!clear) {
      this.unpredicted('\x7f');
      return;
    }
    burst ??= this.openBurst(cur.y, cur.x);
    burst.ops.push({ del: true });
    burst.sentAt.push(this.now());
    this.redraw();
    this.armTimer();
  }

  private redraw(): void {
    const burst = this.burst;
    const term = this.term;
    if (!burst || !term) return;
    if (this._state !== 'active' || burst.ops.length === 0) {
      this.hideOverlay();
      return;
    }
    const cells = simulate(burst.baseX, burst.ops, burst.ops.length);
    const cursor = burst.baseX + netOf(burst.ops);
    const cols = [...cells.keys(), burst.baseX, cursor];
    const start = Math.min(...cols);
    const end = Math.max(...cols);
    let text = '';
    let changed = cursor !== term.cursor().x;
    for (let c = start; c <= end; c++) {
      const real = term.cellAt(burst.row, c);
      const ch = cells.get(c) ?? real;
      if (ch === '\u0000' || real === '\u0000') {
        this.hideOverlay();
        return;
      }
      if (ch !== real) changed = true;
      text += ch;
    }
    try {
      if (changed) term.showOverlay(burst.row, start, text, cursor - start);
      else term.hideOverlay();
    } catch {
      this.disable();
    }
  }

  private validate(): void {
    const term = this.term;
    const burst = this.burst;
    if (!term || !burst) return;
    const cur = term.cursor();
    if (burst.sealed && this.cellsMatch(burst, burst.ops.length)) {
      this.confirm(burst, burst.ops.length);
      this.hideOverlay();
      this.endBurst();
      return;
    }
    const low = Math.max(0, lowestOf(burst.baseX, burst.ops));
    if (this.rowText(burst.row, low) !== burst.prefix.slice(0, low)) {
      this.flush('mismatch');
      return;
    }
    let best = -1;
    const k = cur.x - burst.baseX;
    if (cur.y === burst.row) {
      for (let m = 0; m <= burst.ops.length; m++) {
        if (netOf(burst.ops, m) !== k) continue;
        if (this.cellsMatch(burst, m)) best = m;
      }
    }
    if (burst.sealed && best <= 0) {
      this.hideOverlay();
      this.endBurst();
      return;
    }
    if (best < 0) {
      this.fail();
      return;
    }
    if (best === 0) {
      if (this.reshaped) this.flush('mismatch');
      else this.redraw();
      return;
    }
    this.confirm(burst, best);
    burst.baseX += k;
    burst.prefix = this.rowText(burst.row, burst.baseX);
    burst.ops.splice(0, best);
    burst.sentAt.splice(0, best);
    if (burst.ops.length === 0) {
      this.hideOverlay();
      this.endBurst();
    } else {
      this.redraw();
      this.armTimer();
    }
  }

  private confirm(burst: Burst, m: number): void {
    const now = this.now();
    for (let i = 0; i < m; i++) {
      this.recordRtt(now - burst.sentAt[i]);
      this.streak += 1;
      this.confirms += 1;
    }
    if (m > 0) this.misses = 0;
    if (this.fastLink()) this.setState('shadow');
    else if (this._state === 'shadow' && this.streak >= this.confirmsToEnable) {
      this.setState('active');
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
    this.misses += 1;
    if (this._state === 'active' && this.misses >= MISSES_TO_SHADOW) this.setState('shadow');
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
    this.rttSamples += 1;
    this.rttEwma = this.rttEwma === 0 ? ms : this.rttEwma * 0.75 + ms * 0.25;
  }

  private timeoutMs(): number {
    const base = this.rttEwma > 0 ? this.rttEwma * 3 + 200 : this.timeoutCeilMs;
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
        if (this.burst?.sealed) {
          this.hideOverlay();
          this.endBurst();
        } else this.fail();
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

  private scanTail(data: string, scan: string): boolean {
    this.tail = (this.tail + data).slice(-TAIL_BYTES);
    if (PASSWORD_RE.test(this.tail)) {
      this.suppressUntil = this.now() + PASSWORD_SUPPRESS_MS;
    } else if (data.includes('\n')) {
      this.suppressUntil = 0;
    }
    return ALT_OR_MOUSE_RE.test(scan);
  }
}
