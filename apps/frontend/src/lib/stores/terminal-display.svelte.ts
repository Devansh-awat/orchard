import { browser } from '$app/environment';

export type TerminalCursor = 'bar' | 'block' | 'underline';
export type TerminalBell = 'visual' | 'off';
export type TerminalRenderer = 'gpu' | 'dom';

export interface TerminalDisplay {
	predictiveEcho: boolean;
	fontSize: number;
	cursorStyle: TerminalCursor;
	cursorBlink: boolean;
	bell: TerminalBell;
	renderer: TerminalRenderer;
}

const KEY = 'terminal-display';

export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 24;

const DEFAULTS: TerminalDisplay = {
	predictiveEcho: true,
	fontSize: 12,
	cursorStyle: 'bar',
	cursorBlink: true,
	bell: 'visual',
	renderer: 'gpu'
};

function clampFont(n: unknown): number {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULTS.fontSize;
	return Math.max(TERMINAL_FONT_MIN, Math.min(TERMINAL_FONT_MAX, v));
}

function load(): TerminalDisplay {
	if (!browser) return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return { ...DEFAULTS };
		const saved = JSON.parse(raw) as Partial<TerminalDisplay>;
		return {
			predictiveEcho:
				typeof saved.predictiveEcho === 'boolean' ? saved.predictiveEcho : DEFAULTS.predictiveEcho,
			fontSize: clampFont(saved.fontSize),
			cursorStyle:
				saved.cursorStyle === 'block' || saved.cursorStyle === 'underline'
					? saved.cursorStyle
					: DEFAULTS.cursorStyle,
			cursorBlink:
				typeof saved.cursorBlink === 'boolean' ? saved.cursorBlink : DEFAULTS.cursorBlink,
			bell: saved.bell === 'off' ? 'off' : DEFAULTS.bell,
			renderer: saved.renderer === 'dom' ? 'dom' : DEFAULTS.renderer
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export const terminalDisplay = $state<TerminalDisplay>(load());

export function setTerminalDisplay<K extends keyof TerminalDisplay>(
	key: K,
	value: TerminalDisplay[K]
) {
	terminalDisplay[key] = key === 'fontSize' ? (clampFont(value) as TerminalDisplay[K]) : value;
	if (!browser) return;
	try {
		localStorage.setItem(KEY, JSON.stringify(terminalDisplay));
	} catch {}
}

export function resetTerminalDisplay() {
	for (const key of Object.keys(DEFAULTS) as (keyof TerminalDisplay)[]) {
		setTerminalDisplay(key, DEFAULTS[key]);
	}
}

export function isTerminalDisplayDefault(): boolean {
	return (Object.keys(DEFAULTS) as (keyof TerminalDisplay)[]).every(
		(key) => terminalDisplay[key] === DEFAULTS[key]
	);
}
