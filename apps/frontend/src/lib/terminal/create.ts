import type { WTerm } from '@wterm/dom';
import type { GhosttyCore } from '@wterm/ghostty';
import { loadWterm } from './load';
import { buildTerminalTheme, hex, watchTerminalTheme } from './theme';
import { ensureTerminalFont, monoFontFor } from './font';
import type { FitDims } from './fit';

export type TerminalCursorStyle = 'bar' | 'block' | 'underline';

const LINE_HEIGHT = 1.25;
const SCROLLBACK_BYTES = 8 * 1024 * 1024;

const CURSOR_CODES: Record<TerminalCursorStyle, [blink: number, steady: number]> = {
	block: [1, 2],
	underline: [3, 4],
	bar: [5, 6]
};

export interface TerminalCallbacks {
	onData(data: string): void;
	onBinary(data: Uint8Array): void;
	onResize(cols: number, rows: number): void;
	onTitle(title: string): void;
	onBell(): void;
}

export interface CreateTerminalOptions extends TerminalCallbacks {
	host: HTMLElement;
	backgroundToken?: string;
	fontSize: number;
	cursorStyle: TerminalCursorStyle;
	cursorBlink: boolean;
}

export interface TerminalHandle {
	wt: WTerm;
	core: GhosttyCore;
	readonly cols: number;
	readonly rows: number;
	write(data: string, done?: () => void): void;
	reset(): void;
	propose(): FitDims | undefined;
	resize(cols: number, rows: number): void;
	focus(): void;
	blur(): void;
	setPaused(paused: boolean): void;
	setCursor(style: TerminalCursorStyle, blink: boolean): void;
	setFontSize(px: number): Promise<void>;
	scrolledBack(): boolean;
	dispose(): void;
}

function proposeFor(host: HTMLElement): FitDims | undefined {
	const style = getComputedStyle(host);
	const rowHeight = parseFloat(style.getPropertyValue('--term-row-height'));
	const probe = document.createElement('span');
	probe.setAttribute('aria-hidden', 'true');
	probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:0;left:0';
	probe.textContent = 'W';
	host.appendChild(probe);
	const charWidth = probe.getBoundingClientRect().width;
	probe.remove();
	if (!(charWidth > 0) || !(rowHeight > 0)) return undefined;
	const width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
	const height = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
	if (width <= 0 || height <= 0) return undefined;
	return { cols: width / charWidth, rows: height / rowHeight };
}

function applyFont(host: HTMLElement, px: number): void {
	host.style.setProperty('--term-font-family', monoFontFor(host));
	host.style.setProperty('--term-font-size', `${px}px`);
	host.style.setProperty('--term-line-height', String(LINE_HEIGHT));
	host.style.setProperty('--term-row-height', `${Math.ceil(px * LINE_HEIGHT)}px`);
}

export async function createTerminal(opts: CreateTerminalOptions): Promise<TerminalHandle> {
	const w = await loadWterm();
	const { host } = opts;
	const background = opts.backgroundToken ?? '--bg-app';
	await ensureTerminalFont(host, opts.fontSize);
	applyFont(host, opts.fontSize);

	const theme = buildTerminalTheme(host, { background });
	const core = await w.GhosttyCore.load({
		wasmPath: w.wasmPath,
		scrollbackLimit: SCROLLBACK_BYTES,
		foregroundColor: hex(theme.foreground),
		backgroundColor: hex(theme.background)
	});

	const wt = new w.WTerm(host, {
		core,
		autoResize: true,
		onData: opts.onData,
		onBinary: opts.onBinary,
		onResize: opts.onResize,
		onTitle: opts.onTitle,
		onBell: () => opts.onBell()
	});
	wt.setThemeColors(theme);

	try {
		await wt.init();
	} catch (err) {
		core.dispose();
		throw err;
	}
	wt.autoResize = false;

	let cursor: [TerminalCursorStyle, boolean] = [opts.cursorStyle, opts.cursorBlink];
	const writeCursor = () => {
		const [blink, steady] = CURSOR_CODES[cursor[0]];
		wt.write(`\x1b[${cursor[1] ? blink : steady} q`);
	};
	writeCursor();

	let appliedTheme = JSON.stringify(theme);
	const stopTheme = watchTerminalTheme(
		host,
		(next) => {
			const key = JSON.stringify(next);
			if (key === appliedTheme) return;
			appliedTheme = key;
			wt.setThemeColors(next);
		},
		{ background }
	);
	let disposed = false;

	return {
		wt,
		core,
		get cols() {
			return wt.cols;
		},
		get rows() {
			return wt.rows;
		},
		write(data, done) {
			wt.write(data);
			done?.();
		},
		reset() {
			wt.clearSelection();
			wt.write('\x1bc\x1b[3J');
			writeCursor();
		},
		propose() {
			return proposeFor(host);
		},
		resize(cols, rows) {
			wt.resize(cols, rows);
		},
		focus() {
			wt.focus();
		},
		blur() {
			const active = document.activeElement;
			if (active instanceof HTMLElement && host.contains(active)) active.blur();
		},
		setPaused(paused) {
			wt.setRenderingPaused(paused);
		},
		setCursor(style, blink) {
			if (cursor[0] === style && cursor[1] === blink) return;
			cursor = [style, blink];
			writeCursor();
		},
		async setFontSize(px) {
			await ensureTerminalFont(host, px);
			if (disposed) return;
			applyFont(host, px);
			wt.fit();
		},
		scrolledBack() {
			return host.scrollHeight - host.scrollTop - host.clientHeight >= 5;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopTheme();
			wt.destroy();
			core.dispose();
		}
	};
}
