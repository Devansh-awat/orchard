import type * as Monaco from 'monaco-editor';
import { readRgba, type Rgba } from '$lib/terminal/theme';
import type { MonacoApi } from './load';

export const MONACO_THEME = 'orchard';

const CLEAR = '#00000000';

type Rgb = [number, number, number];

function clamp(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function over(color: Rgba, backdrop: Rgb): Rgb {
	const a = color[3];
	return [
		color[0] * a + backdrop[0] * (1 - a),
		color[1] * a + backdrop[1] * (1 - a),
		color[2] * a + backdrop[2] * (1 - a)
	];
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return [
		from[0] + (to[0] - from[0]) * amount,
		from[1] + (to[1] - from[1]) * amount,
		from[2] + (to[2] - from[2]) * amount
	];
}

function hexOf(rgb: Rgb, alpha = 1): string {
	const parts = [...rgb, alpha * 255].map((v) => clamp(v).toString(16).padStart(2, '0'));
	return `#${alpha >= 1 ? parts.slice(0, 3).join('') : parts.join('')}`;
}

function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((v) => {
		const c = clamp(v) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function legible(color: Rgb, background: Rgb, ink: Rgb, minimum: number): Rgb {
	let out = color;
	for (let step = 1; step <= 20 && contrast(out, background) < minimum; step++) {
		out = mix(color, ink, step / 20);
	}
	return out;
}

interface Palette {
	dark: boolean;
	bg: Rgb;
	ink: Rgb;
	syntax(token: string, minimum?: number): string;
	alpha(token: string, amount: number): string;
	hex(token: string): string;
}

function palette(host: HTMLElement, background: string): Palette & { dispose(): void } {
	const probe = document.createElement('span');
	probe.style.display = 'none';
	host.appendChild(probe);
	const white: Rgb = [255, 255, 255];
	const bg = over(readRgba(probe, background), over(readRgba(probe, '--bg-app'), white));
	const solid = (token: string) => over(readRgba(probe, token), bg);
	const ink = solid('--text-default');
	const dark = luminance(bg) < 0.36;
	return {
		dark,
		bg,
		ink,
		syntax: (token, minimum = 4.5) => hexOf(legible(solid(token), bg, ink, minimum)).slice(1),
		alpha: (token, amount) => {
			const raw = readRgba(probe, token);
			return hexOf([raw[0], raw[1], raw[2]], raw[3] * amount);
		},
		hex: (token) => hexOf(solid(token)),
		dispose: () => probe.remove()
	};
}

function brackets(color: string): Monaco.editor.IColors {
	const out: Monaco.editor.IColors = {
		'editorBracketHighlight.unexpectedBracket.foreground': color
	};
	for (let i = 1; i <= 6; i++) out[`editorBracketHighlight.foreground${i}`] = color;
	return out;
}

const EDITOR_TOKENS = ['--gh-editor', '--bg-app'];

function backgroundToken(host: HTMLElement): string {
	const styles = getComputedStyle(host);
	return EDITOR_TOKENS.find((token) => styles.getPropertyValue(token).trim()) ?? '--bg-app';
}

export interface MonacoThemeOpts {
	background?: string;
}

export function buildMonacoTheme(
	host: HTMLElement,
	opts: MonacoThemeOpts = {}
): Monaco.editor.IStandaloneThemeData {
	const p = palette(host, opts.background ?? backgroundToken(host));
	const bg = hexOf(p.bg);
	const syntax = p.syntax;
	const rules: Monaco.editor.ITokenThemeRule[] = [
		{ token: '', foreground: syntax('--text-default') },
		{ token: 'comment', foreground: syntax('--text-faint', 3), fontStyle: 'italic' },
		{ token: 'keyword', foreground: syntax('--hue-violet') },
		{ token: 'keyword.flow', foreground: syntax('--hue-violet') },
		{ token: 'storage', foreground: syntax('--hue-violet') },
		{ token: 'string', foreground: syntax('--hue-green') },
		{ token: 'string.escape', foreground: syntax('--hue-pink') },
		{ token: 'string.key.json', foreground: syntax('--hue-blue') },
		{ token: 'string.value.json', foreground: syntax('--hue-green') },
		{ token: 'number', foreground: syntax('--hue-amber') },
		{ token: 'constant', foreground: syntax('--hue-amber') },
		{ token: 'regexp', foreground: syntax('--hue-pink') },
		{ token: 'type', foreground: syntax('--hue-blue') },
		{ token: 'type.identifier', foreground: syntax('--hue-blue') },
		{ token: 'namespace', foreground: syntax('--hue-blue') },
		{ token: 'predefined', foreground: syntax('--hue-blue') },
		{ token: 'variable.predefined', foreground: syntax('--hue-blue') },
		{ token: 'annotation', foreground: syntax('--hue-pink') },
		{ token: 'metatag', foreground: syntax('--hue-pink') },
		{ token: 'tag', foreground: syntax('--hue-pink') },
		{ token: 'attribute.name', foreground: syntax('--hue-amber') },
		{ token: 'attribute.value', foreground: syntax('--hue-green') },
		{ token: 'delimiter', foreground: syntax('--text-muted') },
		{ token: 'operator', foreground: syntax('--text-muted') },
		{ token: 'keyword.md', foreground: syntax('--hue-violet'), fontStyle: 'bold' },
		{ token: 'strong', fontStyle: 'bold' },
		{ token: 'emphasis', fontStyle: 'italic' },
		{ token: 'variable.md', foreground: syntax('--hue-pink') },
		{ token: 'string.link.md', foreground: syntax('--text-link') },
		{ token: 'invalid', foreground: syntax('--status-error') }
	];
	const colors: Monaco.editor.IColors = {
		foreground: p.hex('--text-default'),
		focusBorder: CLEAR,
		'widget.shadow': p.dark ? '#00000059' : '#0000001f',
		'widget.border': p.hex('--border-default'),
		'editor.background': bg,
		'editor.foreground': p.hex('--text-default'),
		'editorGutter.background': bg,
		'editorLineNumber.foreground': p.alpha('--text-faint', 0.7),
		'editorLineNumber.activeForeground': p.hex('--text-muted'),
		'editorCursor.foreground': p.hex('--accent'),
		'editor.selectionBackground': p.alpha('--accent', p.dark ? 0.32 : 0.2),
		'editor.inactiveSelectionBackground': p.alpha('--accent', 0.1),
		'editor.selectionHighlightBackground': p.alpha('--accent', 0.1),
		'editor.wordHighlightBackground': p.alpha('--text-default', 0.07),
		'editor.wordHighlightStrongBackground': p.alpha('--text-default', 0.1),
		'editor.lineHighlightBackground': p.alpha('--text-default', p.dark ? 0.045 : 0.035),
		'editor.lineHighlightBorder': CLEAR,
		'editor.findMatchBackground': p.alpha('--status-warning', 0.45),
		'editor.findMatchHighlightBackground': p.alpha('--status-warning', 0.22),
		'editor.findRangeHighlightBackground': p.alpha('--accent', 0.06),
		...brackets(p.hex('--text-muted')),
		'editorBracketMatch.background': p.alpha('--accent', 0.1),
		'editorBracketMatch.border': p.alpha('--accent', 0.4),
		'editorIndentGuide.background1': p.alpha('--text-default', 0.08),
		'editorIndentGuide.activeBackground1': p.alpha('--text-default', 0.2),
		'editorWhitespace.foreground': p.alpha('--text-default', 0.18),
		'editorRuler.foreground': p.alpha('--text-default', 0.08),
		'editorLink.activeForeground': p.hex('--text-link'),
		'editorCodeLens.foreground': p.hex('--text-faint'),
		'editorError.foreground': p.hex('--status-error'),
		'editorWarning.foreground': p.hex('--status-warning'),
		'editorInfo.foreground': p.hex('--status-info'),
		'editorHint.foreground': p.hex('--text-faint'),
		'editorGutter.addedBackground': p.hex('--status-success'),
		'editorGutter.modifiedBackground': p.hex('--status-info'),
		'editorGutter.deletedBackground': p.hex('--status-error'),
		'editorOverviewRuler.border': CLEAR,
		'editorOverviewRuler.background': bg,
		'editorStickyScroll.background': bg,
		'editorStickyScroll.shadow': p.alpha('--text-default', 0.08),
		'editorStickyScrollHover.background': p.hex('--bg-hover'),
		'editorWidget.background': p.hex('--bg-overlay'),
		'editorWidget.foreground': p.hex('--text-default'),
		'editorWidget.border': p.hex('--border-default'),
		'editorWidget.resizeBorder': p.hex('--border-strong'),
		'editorHoverWidget.background': p.hex('--bg-overlay'),
		'editorHoverWidget.border': p.hex('--border-default'),
		'editorHoverWidget.statusBarBackground': p.hex('--bg-raised'),
		'editorSuggestWidget.background': p.hex('--bg-overlay'),
		'editorSuggestWidget.border': p.hex('--border-default'),
		'editorSuggestWidget.foreground': p.hex('--text-default'),
		'editorSuggestWidget.selectedBackground': p.alpha('--accent', 0.12),
		'editorSuggestWidget.selectedForeground': p.hex('--text-default'),
		'editorSuggestWidget.highlightForeground': p.hex('--accent'),
		'editorSuggestWidget.focusHighlightForeground': p.hex('--accent'),
		'list.hoverBackground': p.hex('--bg-hover'),
		'list.activeSelectionBackground': p.alpha('--accent', 0.12),
		'list.activeSelectionForeground': p.hex('--text-default'),
		'list.inactiveSelectionBackground': p.alpha('--text-default', 0.06),
		'list.focusBackground': p.alpha('--accent', 0.12),
		'list.highlightForeground': p.hex('--accent'),
		'input.background': p.hex('--bg-sunken'),
		'input.foreground': p.hex('--text-default'),
		'input.border': p.hex('--border-default'),
		'input.placeholderForeground': p.hex('--text-faint'),
		'inputOption.activeBackground': p.alpha('--accent', 0.14),
		'inputOption.activeBorder': p.alpha('--accent', 0.5),
		'inputOption.activeForeground': p.hex('--text-default'),
		'quickInput.background': p.hex('--bg-overlay'),
		'quickInput.foreground': p.hex('--text-default'),
		'pickerGroup.foreground': p.hex('--text-muted'),
		'pickerGroup.border': p.hex('--border-default'),
		'menu.background': p.hex('--bg-overlay'),
		'menu.foreground': p.hex('--text-default'),
		'menu.selectionBackground': p.alpha('--accent', 0.12),
		'menu.selectionForeground': p.hex('--text-default'),
		'menu.separatorBackground': p.hex('--border-default'),
		'menu.border': p.hex('--border-default'),
		'scrollbar.shadow': CLEAR,
		'scrollbarSlider.background': p.alpha('--text-default', 0.12),
		'scrollbarSlider.hoverBackground': p.alpha('--text-default', 0.2),
		'scrollbarSlider.activeBackground': p.alpha('--text-default', 0.26),
		'minimap.background': bg,
		'minimapSlider.background': p.alpha('--text-default', 0.08),
		'diffEditor.insertedLineBackground': p.alpha('--status-success', p.dark ? 0.13 : 0.11),
		'diffEditor.removedLineBackground': p.alpha('--status-error', p.dark ? 0.13 : 0.1),
		'diffEditor.insertedTextBackground': p.alpha('--status-success', p.dark ? 0.2 : 0.16),
		'diffEditor.removedTextBackground': p.alpha('--status-error', p.dark ? 0.2 : 0.15),
		'diffEditorGutter.insertedLineBackground': p.alpha('--status-success', p.dark ? 0.13 : 0.11),
		'diffEditorGutter.removedLineBackground': p.alpha('--status-error', p.dark ? 0.13 : 0.1),
		'diffEditorOverview.insertedForeground': p.alpha('--status-success', 0.6),
		'diffEditorOverview.removedForeground': p.alpha('--status-error', 0.6),
		'diffEditor.border': p.hex('--border-default'),
		'diffEditor.diagonalFill': p.alpha('--text-default', 0.06),
		'diffEditor.unchangedRegionBackground': p.hex('--bg-sunken'),
		'diffEditor.unchangedRegionForeground': p.hex('--text-muted'),
		'diffEditor.unchangedCodeBackground': CLEAR,
		'diffEditor.move.border': p.alpha('--text-default', 0.2),
		'sash.hoverBorder': p.alpha('--accent', 0.5)
	};
	p.dispose();
	return { base: p.dark ? 'vs-dark' : 'vs', inherit: true, rules, colors };
}

export function applyMonacoTheme(monaco: MonacoApi, host: HTMLElement, opts?: MonacoThemeOpts) {
	monaco.editor.defineTheme(MONACO_THEME, buildMonacoTheme(host, opts));
	monaco.editor.setTheme(MONACO_THEME);
}

const hosts = new Set<HTMLElement>();
let stopWatching: (() => void) | null = null;

function liveHost(): HTMLElement {
	for (const host of hosts) if (host.isConnected) return host;
	return document.body;
}

export function useMonacoTheme(
	monaco: MonacoApi,
	host: HTMLElement = document.body,
	opts?: MonacoThemeOpts
): () => void {
	const first = hosts.size === 0;
	hosts.add(host);
	if (first) {
		applyMonacoTheme(monaco, liveHost(), opts);
		let queued = false;
		const observer = new MutationObserver(() => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				applyMonacoTheme(monaco, liveHost(), opts);
			});
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['style', 'class']
		});
		stopWatching = () => observer.disconnect();
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		hosts.delete(host);
		if (hosts.size === 0) {
			stopWatching?.();
			stopWatching = null;
		}
	};
}
