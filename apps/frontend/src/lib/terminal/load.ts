import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { SearchAddon } from '@xterm/addon-search';
import type { Unicode11Addon } from '@xterm/addon-unicode11';

export interface XtermModules {
	Terminal: typeof Terminal;
	FitAddon: typeof FitAddon;
	WebglAddon: typeof WebglAddon;
	WebLinksAddon: typeof WebLinksAddon;
	SearchAddon: typeof SearchAddon;
	Unicode11Addon: typeof Unicode11Addon;
}

let loading: Promise<XtermModules> | null = null;

export function loadXterm(): Promise<XtermModules> {
	loading ??= Promise.all([
		import('@xterm/xterm'),
		import('@xterm/addon-fit'),
		import('@xterm/addon-webgl'),
		import('@xterm/addon-web-links'),
		import('@xterm/addon-search'),
		import('@xterm/addon-unicode11'),
		import('@xterm/xterm/css/xterm.css')
	]).then(([core, fit, webgl, links, search, unicode]) => ({
		Terminal: core.Terminal,
		FitAddon: fit.FitAddon,
		WebglAddon: webgl.WebglAddon,
		WebLinksAddon: links.WebLinksAddon,
		SearchAddon: search.SearchAddon,
		Unicode11Addon: unicode.Unicode11Addon
	}));
	return loading;
}
