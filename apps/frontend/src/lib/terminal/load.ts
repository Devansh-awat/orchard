import type { WTerm } from '@wterm/dom';
import type { GhosttyCore } from '@wterm/ghostty';

export interface WtermModules {
	WTerm: typeof WTerm;
	GhosttyCore: typeof GhosttyCore;
	wasmPath: string;
}

let loading: Promise<WtermModules> | null = null;

export function loadWterm(): Promise<WtermModules> {
	loading ??= Promise.all([
		import('@wterm/dom'),
		import('@wterm/ghostty'),
		import('@wterm/ghostty/ghostty-vt.wasm?url'),
		import('@wterm/dom/src/terminal.css')
	])
		.then(([dom, ghostty, wasm]) => ({
			WTerm: dom.WTerm,
			GhosttyCore: ghostty.GhosttyCore,
			wasmPath: wasm.default
		}))
		.catch((err) => {
			loading = null;
			throw err;
		});
	return loading;
}
