export interface MouseTerminal {
	cols: number;
	rows: number;
	renderer?: { getMetrics(): { width: number; height: number } };
	wasmTerm?: { isAlternateScreen(): boolean };
	hasMouseTracking(): boolean;
	getMode(mode: number, isAnsi?: boolean): boolean;
	input(data: string, wasUserInput?: boolean): void;
	attachCustomWheelEventHandler(handler?: (event: WheelEvent) => boolean): void;
	focus(): void;
}

const MODE_APP_CURSOR = 1;
const MODE_BUTTON_MOTION = 1002;
const MODE_ANY_MOTION = 1003;
const MODE_SGR = 1006;
const X10_MAX = 223;
const WHEEL_LINE_PX = 33;
const WHEEL_MAX_STEPS = 5;

type Cell = { col: number; row: number };

export function attachMouseReporting(term: MouseTerminal, host: HTMLElement): () => void {
	let pressed: number | null = null;
	let lastMotion: Cell | null = null;

	const tracking = () => term.hasMouseTracking();

	function cellAt(e: MouseEvent): Cell | null {
		const canvas = host.querySelector('canvas');
		const metrics = term.renderer?.getMetrics();
		if (!canvas || !metrics || metrics.width <= 0 || metrics.height <= 0) return null;
		const rect = canvas.getBoundingClientRect();
		const col = Math.floor((e.clientX - rect.left) / metrics.width);
		const row = Math.floor((e.clientY - rect.top) / metrics.height);
		return {
			col: Math.max(1, Math.min(term.cols, col + 1)),
			row: Math.max(1, Math.min(term.rows, row + 1))
		};
	}

	function mods(e: MouseEvent): number {
		return (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);
	}

	function send(button: number, cell: Cell, release: boolean) {
		if (term.getMode(MODE_SGR)) {
			term.input(`\x1b[<${button};${cell.col};${cell.row}${release ? 'm' : 'M'}`, true);
			return;
		}
		if (cell.col > X10_MAX || cell.row > X10_MAX) return;
		const code = release ? 3 : button;
		term.input(
			`\x1b[M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + cell.col)}${String.fromCharCode(32 + cell.row)}`,
			true
		);
	}

	function buttonOf(e: MouseEvent): number | null {
		return e.button === 0 || e.button === 1 || e.button === 2 ? e.button : null;
	}

	function onMouseDown(e: MouseEvent) {
		if (!tracking()) return;
		const button = buttonOf(e);
		const cell = cellAt(e);
		e.preventDefault();
		e.stopPropagation();
		term.focus();
		if (button === null || !cell) return;
		pressed = button;
		lastMotion = null;
		send(button | mods(e), cell, false);
	}

	function onMouseUp(e: MouseEvent) {
		if (pressed === null) return;
		const button = pressed;
		pressed = null;
		lastMotion = null;
		if (!tracking()) return;
		const cell = cellAt(e);
		if (!cell) return;
		e.preventDefault();
		send(button | mods(e), cell, true);
	}

	function onMouseMove(e: MouseEvent) {
		if (!tracking()) return;
		const any = term.getMode(MODE_ANY_MOTION);
		if (!any && !(term.getMode(MODE_BUTTON_MOTION) && pressed !== null)) return;
		const cell = cellAt(e);
		if (!cell) return;
		if (lastMotion && lastMotion.col === cell.col && lastMotion.row === cell.row) return;
		lastMotion = cell;
		e.preventDefault();
		e.stopPropagation();
		send(((pressed ?? 3) + 32) | mods(e), cell, false);
	}

	function onContextMenu(e: MouseEvent) {
		if (!tracking()) return;
		e.preventDefault();
		e.stopPropagation();
	}

	function onWheel(e: WheelEvent): boolean {
		const steps = Math.max(
			1,
			Math.min(WHEEL_MAX_STEPS, Math.round(Math.abs(e.deltaY) / WHEEL_LINE_PX))
		);
		const up = e.deltaY < 0;
		if (tracking()) {
			const cell = cellAt(e);
			if (!cell) return true;
			const button = (up ? 64 : 65) | mods(e);
			for (let i = 0; i < steps; i++) send(button, cell, false);
			return true;
		}
		if (term.wasmTerm?.isAlternateScreen()) {
			const app = term.getMode(MODE_APP_CURSOR);
			const seq = app ? (up ? '\x1bOA' : '\x1bOB') : up ? '\x1b[A' : '\x1b[B';
			for (let i = 0; i < steps; i++) term.input(seq, true);
			return true;
		}
		return false;
	}

	host.addEventListener('mousedown', onMouseDown, { capture: true });
	host.addEventListener('mousemove', onMouseMove, { capture: true });
	host.addEventListener('contextmenu', onContextMenu, { capture: true });
	document.addEventListener('mouseup', onMouseUp, { capture: true });
	term.attachCustomWheelEventHandler(onWheel);

	return () => {
		host.removeEventListener('mousedown', onMouseDown, { capture: true });
		host.removeEventListener('mousemove', onMouseMove, { capture: true });
		host.removeEventListener('contextmenu', onContextMenu, { capture: true });
		document.removeEventListener('mouseup', onMouseUp, { capture: true });
		try {
			term.attachCustomWheelEventHandler(undefined);
		} catch {
			return;
		}
	};
}
