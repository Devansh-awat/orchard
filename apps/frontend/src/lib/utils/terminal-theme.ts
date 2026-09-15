type Rgba = [number, number, number, number];

function readRgba(probe: HTMLElement, token: string): Rgba {
	probe.style.color = '';
	probe.style.color = `var(${token})`;
	const value = getComputedStyle(probe).color;
	const parts = value.match(/[\d.]+/g);
	if (!parts || parts.length < 3) return [0, 0, 0, 1];
	const scale = value.startsWith('color(') ? 255 : 1;
	return [
		Number(parts[0]) * scale,
		Number(parts[1]) * scale,
		Number(parts[2]) * scale,
		parts[3] === undefined ? 1 : Number(parts[3])
	];
}

function channel(value: number): string {
	return Math.max(0, Math.min(255, Math.round(value)))
		.toString(16)
		.padStart(2, '0');
}

function flatten(color: Rgba, backdrop: Rgba): string {
	const alpha = color[3];
	const mix = (i: number) => color[i] * alpha + backdrop[i] * (1 - alpha);
	return `#${channel(mix(0))}${channel(mix(1))}${channel(mix(2))}`;
}

export interface TerminalThemeOpts {
	background?: string;
}

export function buildTerminalTheme(host: HTMLElement, opts: TerminalThemeOpts = {}) {
	const bgToken = opts.background ?? '--bg-app';
	const probe = document.createElement('span');
	probe.style.display = 'none';
	host.appendChild(probe);
	const backdrop = readRgba(probe, bgToken);
	const pick = (token: string) => flatten(readRgba(probe, token), backdrop);
	const theme = {
		background: pick(bgToken),
		foreground: pick('--text-default'),
		cursor: pick('--accent'),
		cursorAccent: pick(bgToken),
		selectionBackground: pick('--accent-subtle'),
		black: pick('--bg-sunken'),
		red: pick('--status-error'),
		green: pick('--status-success'),
		yellow: pick('--status-warning'),
		blue: pick('--hue-blue'),
		magenta: pick('--hue-violet'),
		cyan: pick('--hue-emerald'),
		white: pick('--text-muted'),
		brightBlack: pick('--text-faint'),
		brightRed: pick('--hue-red'),
		brightGreen: pick('--hue-green'),
		brightYellow: pick('--hue-amber'),
		brightBlue: pick('--hue-blue'),
		brightMagenta: pick('--hue-pink'),
		brightCyan: pick('--hue-emerald'),
		brightWhite: pick('--text-default')
	};
	probe.remove();
	return theme;
}

export type TerminalTheme = ReturnType<typeof buildTerminalTheme>;

export function applyTerminalTheme(terminal: any, theme: TerminalTheme): void {
	const renderer = terminal?.renderer;
	if (!renderer?.setTheme) return;
	renderer.setTheme(theme);
	if (!terminal.wasmTerm) return;
	try {
		renderer.render(
			terminal.wasmTerm,
			true,
			terminal.viewportY,
			terminal,
			terminal.scrollbarOpacity
		);
	} catch {}
}

export function monoFontFor(el: HTMLElement): string {
	return getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'monospace';
}

export function watchTerminalTheme(
	host: HTMLElement,
	apply: (theme: ReturnType<typeof buildTerminalTheme>) => void,
	opts: TerminalThemeOpts = {}
): () => void {
	let queued = false;
	const observer = new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			if (!host.isConnected) return;
			apply(buildTerminalTheme(host, opts));
		});
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['style', 'class']
	});
	return () => observer.disconnect();
}
