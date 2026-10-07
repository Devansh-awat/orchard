import type { Terminal } from '@xterm/xterm';

export interface KeyHandlerDeps {
	term: Terminal;
	onKeyDown?: (event: KeyboardEvent) => void;
	onClear: () => void;
	onZoom: (step: 1 | -1 | 0) => void;
}

export function makeKeyHandler(deps: KeyHandlerDeps): (event: KeyboardEvent) => boolean {
	return (event) => {
		if (event.type !== 'keydown') return true;
		deps.onKeyDown?.(event);

		if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey) {
			if (event.code === 'KeyC') {
				if (!deps.term.hasSelection()) return true;
				void navigator.clipboard?.writeText(deps.term.getSelection()).catch(() => {});
				return false;
			}
			if (event.code === 'KeyV') return true;
		}

		if (event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyK') {
			event.stopPropagation();
			deps.onClear();
			return false;
		}

		const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
		if (mod) {
			if (event.code === 'Equal' || event.code === 'NumpadAdd') {
				event.stopPropagation();
				deps.onZoom(1);
				return false;
			}
			if (!event.shiftKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
				event.stopPropagation();
				deps.onZoom(-1);
				return false;
			}
			if (!event.shiftKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
				event.stopPropagation();
				deps.onZoom(0);
				return false;
			}
		}

		return true;
	};
}
