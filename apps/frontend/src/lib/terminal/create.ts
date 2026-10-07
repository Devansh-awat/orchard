import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebglAddon } from '@xterm/addon-webgl';
import { loadXterm } from './load';
import { buildTerminalTheme, watchTerminalTheme } from './theme';
import { ensureTerminalFont, monoFontFor } from './font';

export type TerminalRenderer = 'webgl' | 'dom';

export interface CreateTerminalOptions {
	host: HTMLElement;
	backgroundToken?: string;
	fontSize: number;
	cursorStyle: 'bar' | 'block' | 'underline';
	cursorBlink: boolean;
	gpu?: boolean;
}

export interface TerminalHandle {
	term: Terminal;
	fit: FitAddon;
	search: SearchAddon;
	renderer: TerminalRenderer;
	applyTheme(): void;
	setFontSize(px: number): Promise<void>;
	dispose(): void;
}

export async function createTerminal(opts: CreateTerminalOptions): Promise<TerminalHandle> {
	const x = await loadXterm();
	const { host } = opts;
	const background = opts.backgroundToken ?? '--bg-app';
	await ensureTerminalFont(host, opts.fontSize);

	const term = new x.Terminal({
		allowProposedApi: true,
		scrollback: 10_000,
		cursorBlink: opts.cursorBlink,
		cursorStyle: opts.cursorStyle,
		cursorInactiveStyle: 'outline',
		fontSize: opts.fontSize,
		fontFamily: monoFontFor(host),
		theme: buildTerminalTheme(host, { background }),
		macOptionIsMeta: true,
		scrollOnUserInput: true,
		smoothScrollDuration: 0
	});

	const fit = new x.FitAddon();
	term.loadAddon(fit);
	term.loadAddon(
		new x.WebLinksAddon((event, uri) => {
			if (!event.metaKey && !event.ctrlKey) return;
			window.open(uri, '_blank', 'noopener,noreferrer');
		})
	);
	const search = new x.SearchAddon();
	term.loadAddon(search);
	term.loadAddon(new x.Unicode11Addon());
	term.unicode.activeVersion = '11';

	term.open(host);

	let webgl: WebglAddon | null = null;
	const onFontsDone = () => {
		webgl?.clearTextureAtlas();
	};
	const stopTheme = watchTerminalTheme(
		host,
		(theme) => {
			term.options.theme = theme;
		},
		{ background }
	);
	const handle: TerminalHandle = {
		term,
		fit,
		search,
		renderer: 'dom',
		applyTheme() {
			term.options.theme = buildTerminalTheme(host, { background });
		},
		async setFontSize(px) {
			await ensureTerminalFont(host, px);
			term.options.fontSize = px;
		},
		dispose() {
			document.fonts?.removeEventListener('loadingdone', onFontsDone);
			stopTheme();
			webgl?.dispose();
			webgl = null;
			term.dispose();
		}
	};

	if (opts.gpu !== false) {
		try {
			const addon = new x.WebglAddon();
			addon.onContextLoss(() => {
				addon.dispose();
				if (webgl === addon) webgl = null;
				handle.renderer = 'dom';
			});
			term.loadAddon(addon);
			webgl = addon;
			handle.renderer = 'webgl';
		} catch {
			webgl = null;
			handle.renderer = 'dom';
		}
	}

	document.fonts?.addEventListener('loadingdone', onFontsDone);

	return handle;
}
