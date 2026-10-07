import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { PredictTarget } from '$lib/utils/terminal-predict';

export interface DisposablePredictTarget extends PredictTarget {
	dispose(): void;
}

export function xtermPredictTarget(term: Terminal): DisposablePredictTarget {
	let marker: IMarker | null = null;
	let decoration: IDecoration | null = null;
	let shownText = '';
	let shownX = -1;

	function hideOverlay(): void {
		decoration?.dispose();
		marker?.dispose();
		decoration = null;
		marker = null;
		shownText = '';
		shownX = -1;
	}

	function paint(el: HTMLElement, text: string): void {
		const theme = term.options.theme ?? {};
		el.textContent = text;
		el.style.whiteSpace = 'pre';
		el.style.pointerEvents = 'none';
		el.style.overflow = 'hidden';
		el.style.font = `${term.options.fontSize ?? 14}px ${term.options.fontFamily ?? 'monospace'}`;
		el.style.lineHeight = el.style.height;
		el.style.color = theme.foreground ?? 'inherit';
		el.style.background = theme.background ?? 'transparent';
		el.style.textDecoration = 'underline';
		el.style.textDecorationStyle = 'dotted';
		el.style.boxShadow = `inset -1px 0 0 ${theme.cursor ?? 'currentColor'}`;
	}

	function showOverlay(_row: number, x: number, text: string): void {
		if (decoration && !decoration.marker.isDisposed && shownX === x) {
			shownText = text;
			if (decoration.element) {
				const width = Math.max(1, text.length);
				decoration.element.style.width = `${width * cellWidth()}px`;
				paint(decoration.element, text);
			}
			return;
		}
		hideOverlay();
		marker = term.registerMarker(0);
		if (!marker || marker.isDisposed) {
			marker = null;
			return;
		}
		const created = term.registerDecoration({
			marker,
			x,
			width: Math.max(1, text.length),
			layer: 'top'
		});
		if (!created) {
			marker.dispose();
			marker = null;
			return;
		}
		decoration = created;
		shownText = text;
		shownX = x;
		created.onRender((el) => paint(el, shownText));
		created.onDispose(() => {
			if (decoration === created) {
				decoration = null;
				marker = null;
				shownText = '';
				shownX = -1;
			}
		});
	}

	function cellWidth(): number {
		const el = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
		if (!el || term.cols === 0) return 0;
		return el.clientWidth / term.cols;
	}

	return {
		get cols() {
			return term.cols;
		},
		cursor() {
			const b = term.buffer.active;
			return { x: b.cursorX, y: b.cursorY };
		},
		cellAt(row, col) {
			const b = term.buffer.active;
			const line = b.getLine(b.baseY + row);
			const cell = line?.getCell(col);
			if (!cell) return ' ';
			if (cell.getWidth() === 0) return '\u0000';
			const chars = cell.getChars();
			return chars === '' ? ' ' : chars;
		},
		isAlternate() {
			return term.buffer.active.type === 'alternate';
		},
		mouseTracking() {
			return term.modes.mouseTrackingMode !== 'none';
		},
		scrolledBack() {
			const b = term.buffer.active;
			return b.viewportY !== b.baseY;
		},
		write(data, done) {
			term.write(data, done);
		},
		showOverlay,
		hideOverlay,
		dispose: hideOverlay
	};
}
