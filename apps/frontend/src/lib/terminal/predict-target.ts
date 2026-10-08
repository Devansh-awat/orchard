import type { PredictTarget } from '$lib/utils/terminal-predict';
import type { TerminalHandle } from './create';

export interface DisposablePredictTarget extends PredictTarget {
	dispose(): void;
}

export const PREDICT_OVERLAY_CLASS = 'term-predict-overlay';
export const PREDICT_CURSOR_CLASS = 'term-predict-cursor';

function liveRow(host: HTMLElement, rows: number, row: number): HTMLElement | null {
	const grid = host.querySelector<HTMLElement>(':scope > .term-grid');
	if (!grid) return null;
	const all = grid.querySelectorAll<HTMLElement>(':scope > .term-row');
	return all[all.length - rows + row] ?? null;
}

export function wtermPredictTarget(handle: TerminalHandle): DisposablePredictTarget {
	const host = handle.wt.element;
	const core = handle.core;
	let overlay: HTMLDivElement | null = null;

	function hideOverlay(): void {
		overlay?.remove();
		overlay = null;
	}

	function showOverlay(row: number, x: number, text: string, cursor: number): void {
		const rowEl = liveRow(host, handle.rows, row);
		const grid = rowEl?.parentElement;
		if (!rowEl || !grid) {
			hideOverlay();
			return;
		}
		const cell = parseFloat(getComputedStyle(host).getPropertyValue('--term-cell-width')) || 0;
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.className = PREDICT_OVERLAY_CLASS;
			overlay.setAttribute('aria-hidden', 'true');
			overlay.append(document.createTextNode(''), document.createElement('span'));
			(overlay.lastChild as HTMLElement).className = PREDICT_CURSOR_CLASS;
		}
		if (overlay.parentElement !== host) host.appendChild(overlay);
		(overlay.firstChild as Text).data = text;
		(overlay.lastChild as HTMLElement).style.left = `${cursor * cell}px`;
		overlay.style.top = `${grid.offsetTop + rowEl.offsetTop}px`;
		overlay.style.left = `${grid.offsetLeft + x * cell}px`;
		overlay.style.width = `${Math.max(text.length, cursor + 1) * cell}px`;
	}

	return {
		get cols() {
			return handle.cols;
		},
		cursor() {
			const c = core.getCursor();
			return { x: c.col, y: c.row };
		},
		cellAt(row, col) {
			const cell = core.getCell(row, col);
			if (cell.width === 0) return '\u0000';
			if (cell.chars) return cell.chars;
			return cell.char > 0 ? String.fromCodePoint(cell.char) : ' ';
		},
		isAlternate() {
			return core.usingAltScreen();
		},
		mouseTracking() {
			return core.mouseTracking() !== 0;
		},
		scrolledBack() {
			return handle.scrolledBack();
		},
		write(data, done) {
			handle.write(data, done);
		},
		showOverlay,
		hideOverlay,
		dispose: hideOverlay
	};
}
