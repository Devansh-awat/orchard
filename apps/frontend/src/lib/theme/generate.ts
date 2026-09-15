import { clamp, contrastRatio, hexToOklch, hexToRgb, mixHex, oklch, oklchAlpha } from './color';
import {
	angleToHue,
	maxChroma,
	specNodes,
	vividnessFor,
	type Scheme,
	type ThemeSpec
} from './spec';

export interface SimpleThemeColors {
	accent: string;
	accentForeground: string;
	background: string;
	foreground: string;
	muted: string;
	border: string;
	card: string;
	sidebarBackground: string;
	sidebarForeground: string;
	error: string;
	success: string;
	warning: string;
}

export interface ThemeColors {
	primary50: string;
	primary100: string;
	primary200: string;
	primary300: string;
	primary400: string;
	primary500: string;
	primary600: string;
	primary700: string;
	primary800: string;
	primary900: string;
	primary950: string;

	sidebarBg: string;
	sidebarText: string;
	sidebarUnreadText: string;
	sidebarTextHoverBg: string;
	sidebarTextActiveBorder: string;
	sidebarTextActiveColor: string;
	sidebarTextActiveBg: string;
	sidebarHeaderBg: string;
	sidebarHeaderText: string;
	sidebarTeamBarBg: string;

	onlineIndicator: string;
	awayIndicator: string;
	dndIndicator: string;

	mentionBg: string;
	mentionColor: string;
	mentionHighlightBg: string;
	mentionHighlightLink: string;

	centerChannelBg: string;
	centerChannelColor: string;
	newMessageSeparator: string;
	linkColor: string;

	buttonBg: string;
	buttonColor: string;

	errorTextColor: string;

	surfaceBg: string;
	surfaceBorder: string;
	surfaceMuted: string;
	cardBg: string;

	controlBg: string;
	controlHoverBg: string;
	controlText: string;

	dropdownBg: string;
	dropdownBorder: string;
	dropdownHoverBg: string;

	dividerColor: string;
	orgTriggerBg: string;
	orgTriggerHoverBg: string;
}

type Ladder = {
	bg: number;
	sidebar: number;
	card: number;
	control: number;
	controlHover: number;
	overlay: number;
	border: number;
	ink: number;
	inkStrong: number;
	muted: number;
	accent: number;
	accentChroma: number;
	statusVividness: number;
	tintedBg: number;
	hoverBg: number;
	neutralChroma: number;
	surfaceShift: number;
	surface: {
		bg: number;
		card: number;
		sidebar: number;
		ink: number;
		muted: number;
		border: number;
	};
	field: number;
	ramp: number[];
	status: { success: number; warning: number; error: number };
	chromeL: number;
	chromeAlpha: number;
};

const LADDERS: Record<Scheme, Ladder> = {
	light: {
		bg: 0.971,
		sidebar: 0.971,
		card: 0.997,
		control: 0.952,
		controlHover: 0.932,
		overlay: 0.998,
		border: 0.916,
		ink: 0.239,
		inkStrong: 0.16,
		muted: 0.552,
		accent: 0.575,
		accentChroma: 1,
		statusVividness: 0.9,
		tintedBg: 0.932,
		hoverBg: 0.938,
		neutralChroma: 0.1,
		surfaceShift: -0.062,
		surface: { bg: 0.55, card: 0.42, sidebar: 0.72, ink: 0.55, muted: 1, border: 1.3 },
		field: 0.7,
		ramp: [0.985, 0.93, 0.855, 0.77, 0.675, 0.575, 0.505, 0.44, 0.375, 0.31, 0.215],
		status: { success: 0.695, warning: 0.704, error: 0.575 },
		chromeL: 0.74,
		chromeAlpha: 0.5
	},
	dark: {
		bg: 0.145,
		sidebar: 0.135,
		card: 0.183,
		control: 0.183,
		controlHover: 0.235,
		overlay: 0.165,
		border: 0.262,
		ink: 0.947,
		inkStrong: 0.99,
		muted: 0.652,
		accent: 0.625,
		accentChroma: 0.9,
		statusVividness: 0.78,
		tintedBg: 0.255,
		hoverBg: 0.205,
		neutralChroma: 0.115,
		surfaceShift: 0.075,
		surface: { bg: 0.8, card: 1.15, sidebar: 0.7, ink: 0.45, muted: 0.95, border: 1.35 },
		field: 0.62,
		ramp: [0.965, 0.925, 0.855, 0.79, 0.71, 0.625, 0.555, 0.485, 0.41, 0.34, 0.245],
		status: { success: 0.783, warning: 0.813, error: 0.715 },
		chromeL: 0.56,
		chromeAlpha: 0.4
	}
};

const RAMP_CHROMA = [0.1, 0.34, 0.62, 0.85, 0.96, 1, 1, 0.95, 0.88, 0.8, 0.55];

const STATUS_HUES = { success: 165, warning: 62, error: 22 };

function meanHue(hues: number[]): number {
	if (hues.length === 1) return hues[0];
	let sx = 0;
	let sy = 0;
	for (const h of hues) {
		const rad = (h * Math.PI) / 180;
		sx += Math.cos(rad);
		sy += Math.sin(rad);
	}
	if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return hues[0];
	const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
	return (deg + 360) % 360;
}

function tone(l: number, hue: number, vividness: number, scale: number): string {
	return oklch(l, maxChroma(hue, l) * clamp(vividness * scale, 0, 1), hue);
}

function readableOn(fill: string): string {
	const white = '#ffffff';
	const ink = oklch(0.185, 0.012, hexToOklch(fill).h);
	return contrastRatio(fill, white) >= contrastRatio(fill, ink) ? white : ink;
}

export type PaletteSample = { hue: number; vividness: number };

export function samplePalette(spec: ThemeSpec): PaletteSample[] {
	return specNodes(spec).map((n) => ({ hue: n.hue, vividness: n.vividness }));
}

export function deriveSimpleColors(spec: ThemeSpec, scheme: Scheme): SimpleThemeColors {
	const L = LADDERS[scheme];
	const samples = samplePalette(spec);
	const accent = samples[0];
	const neutralHue = meanHue(samples.map((s) => s.hue));

	const colourfulness = Math.pow(clamp(accent.vividness, 0, 1), 0.6);
	const tint = spec.blend * L.neutralChroma * colourfulness;
	const shift = spec.blend * L.surfaceShift * (0.3 + 0.7 * colourfulness);
	const neutral = (base: number, scale: number, weight = 1) => {
		const l = clamp(base + shift * weight, 0.02, 0.999);
		return oklch(l, Math.min(tint * scale, maxChroma(neutralHue, l)), neutralHue);
	};

	const accentHex = tone(L.accent, accent.hue, accent.vividness, L.accentChroma);

	return {
		accent: accentHex,
		accentForeground: readableOn(accentHex),
		background: neutral(L.bg, L.surface.bg),
		foreground: neutral(L.ink, L.surface.ink, 0),
		muted: neutral(L.muted, L.surface.muted, 0.6),
		border: neutral(L.border, L.surface.border, 0.6),
		card: neutral(L.card, L.surface.card),
		sidebarBackground: neutral(L.sidebar, L.surface.sidebar),
		sidebarForeground: neutral(L.ink, L.surface.ink, 0),
		error: tone(L.status.error, STATUS_HUES.error, L.statusVividness, 1),
		success: tone(L.status.success, STATUS_HUES.success, L.statusVividness, 1),
		warning: tone(L.status.warning, STATUS_HUES.warning, L.statusVividness, 1)
	};
}

export function generateThemeColors(simple: SimpleThemeColors, isDark: boolean): ThemeColors {
	const scheme: Scheme = isDark ? 'dark' : 'light';
	const L = LADDERS[scheme];

	const acc = hexToOklch(simple.accent);
	const accentCeiling = maxChroma(acc.h, acc.l);
	const accentVividness = accentCeiling > 0 ? clamp(acc.c / accentCeiling, 0, 1) : 0;

	const neu = hexToOklch(simple.background);
	const neutralHue = neu.c < 0.004 ? acc.h : neu.h;
	const base = neu.c / Math.max(L.surface.bg, 0.01);
	const shift = neu.l - L.bg;
	const neutral = (from: number, scale: number, weight = 1) => {
		const l = clamp(from + shift * weight, 0.02, 0.999);
		return oklch(l, Math.min(base * scale, maxChroma(neutralHue, l)), neutralHue);
	};

	const anchor = clamp(acc.l, L.ramp[10] + 0.02, L.ramp[0] - 0.02);
	const ramp = L.ramp.map((base, i) => {
		const [from, to] = i <= 5 ? [L.ramp[0], L.ramp[5]] : [L.ramp[5], L.ramp[10]];
		const [mapped, target] = i <= 5 ? [L.ramp[0], anchor] : [anchor, L.ramp[10]];
		const t = from === to ? 0 : (base - from) / (to - from);
		const l = clamp(mapped + t * (target - mapped), 0.04, 0.995);
		return oklch(l, maxChroma(acc.h, l) * clamp(accentVividness * RAMP_CHROMA[i], 0, 1), acc.h);
	});
	const [p50, p100, p200, p300, p400, p500, p600, p700, p800, p900, p950] = ramp;

	const accentTint = (l: number, scale: number) =>
		oklch(l, maxChroma(acc.h, l) * clamp(accentVividness * scale, 0, 1), acc.h);

	const hoverBg = neutral(L.hoverBg, L.surface.card * 1.3);
	const activeBg = accentTint(
		clamp(L.tintedBg + shift, 0.02, 0.999),
		scheme === 'dark' ? 0.24 : 0.2
	);
	const onAccent = simple.accentForeground || readableOn(simple.accent);

	return {
		primary50: p50,
		primary100: p100,
		primary200: p200,
		primary300: p300,
		primary400: p400,
		primary500: p500,
		primary600: p600,
		primary700: p700,
		primary800: p800,
		primary900: p900,
		primary950: p950,

		sidebarBg: simple.sidebarBackground,
		sidebarText: simple.sidebarForeground,
		sidebarUnreadText: neutral(L.inkStrong, L.surface.ink, 0),
		sidebarTextHoverBg: hoverBg,
		sidebarTextActiveBorder: simple.accent,
		sidebarTextActiveColor: scheme === 'dark' ? neutral(L.inkStrong, L.surface.ink, 0) : p700,
		sidebarTextActiveBg: activeBg,
		sidebarHeaderBg: simple.sidebarBackground,
		sidebarHeaderText: simple.sidebarForeground,
		sidebarTeamBarBg: simple.sidebarBackground,

		onlineIndicator: simple.success,
		awayIndicator: simple.warning,
		dndIndicator: simple.error,

		mentionBg: simple.accent,
		mentionColor: onAccent,
		mentionHighlightBg: activeBg,
		mentionHighlightLink: scheme === 'dark' ? p300 : p700,

		centerChannelBg: simple.background,
		centerChannelColor: simple.foreground,
		newMessageSeparator: scheme === 'dark' ? p500 : p400,
		linkColor: scheme === 'dark' ? p300 : p700,

		buttonBg: p600,
		buttonColor: onAccent,

		errorTextColor: simple.error,

		surfaceBg: simple.background,
		surfaceBorder: simple.border,
		surfaceMuted: simple.muted,
		cardBg: simple.card,

		controlBg: neutral(L.control, L.surface.card),
		controlHoverBg: neutral(L.controlHover, L.surface.card * 1.45),
		controlText: simple.foreground,

		dropdownBg: neutral(L.overlay, L.surface.card),
		dropdownBorder: simple.border,
		dropdownHoverBg: hoverBg,

		dividerColor: simple.border,
		orgTriggerBg: simple.card,
		orgTriggerHoverBg: neutral(L.controlHover, L.surface.card * 1.45)
	};
}

const BLOBS = [
	{ x: 14, y: -4, rx: 82, ry: 66 },
	{ x: 94, y: 10, rx: 72, ry: 60 },
	{ x: 48, y: 106, rx: 90, ry: 66 },
	{ x: -6, y: 84, rx: 64, ry: 58 },
	{ x: 80, y: 96, rx: 68, ry: 58 }
];

export type ChromeVars = {
	image: string;
	grain: string;
	accentGlow: string;
};

function grainImage(amount: number): string {
	if (amount <= 0) return 'none';
	const opacity = Math.round(clamp(amount, 0, 1) * 0.42 * 1000) / 1000;
	return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.45' numOctaves='1' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)' opacity='${opacity}'/%3E%3C/svg%3E")`;
}

export function generateChrome(spec: ThemeSpec, scheme: Scheme): ChromeVars {
	const L = LADDERS[scheme];
	const samples = samplePalette(spec);
	const strength = spec.blend * L.chromeAlpha;

	const stop = (s: PaletteSample, alpha: number) =>
		oklchAlpha(
			L.chromeL,
			maxChroma(s.hue, L.chromeL) * clamp(s.vividness * 0.85, 0, 1),
			s.hue,
			alpha
		);

	let image: string;
	if (samples.length === 1) {
		const flat = stop(samples[0], strength);
		image = `linear-gradient(${flat}, ${flat})`;
	} else {
		image = samples
			.map((s, i) => {
				const b = BLOBS[i % BLOBS.length];
				const fade = i === 0 ? 1 : 0.88;
				return `radial-gradient(${b.rx}% ${b.ry}% at ${b.x}% ${b.y}%, ${stop(s, strength * fade)} 0%, ${stop(s, 0)} 72%)`;
			})
			.join(', ');
	}

	const accent = samples[0];
	return {
		image,
		grain: grainImage(spec.grain),
		accentGlow: oklchAlpha(
			L.chromeL,
			maxChroma(accent.hue, L.chromeL) * clamp(accent.vividness, 0, 1),
			accent.hue,
			0.22 + spec.blend * 0.2
		)
	};
}

const FIELD_CHROMA = 0.92;

export function nodeSwatch(sample: PaletteSample, scheme: Scheme): string {
	const l = LADDERS[scheme].field;
	const vivid = oklch(l, maxChroma(sample.hue, l) * FIELD_CHROMA, sample.hue);
	return mixHex(vivid, oklch(l, 0, 0), sample.vividness);
}

export function fieldNeutral(scheme: Scheme): string {
	return oklch(LADDERS[scheme].field, 0, 0);
}

export function fieldFalloff(scheme: Scheme): string {
	const neutral = fieldNeutral(scheme);
	const { r, g, b } = hexToRgb(neutral);
	const channel = (v: number) => Math.round(v * 255);
	const steps = 12;
	const stops: string[] = [];
	for (let i = 0; i <= steps; i++) {
		const radius = i / steps;
		const alpha = Math.round((1 - vividnessFor(radius)) * 1000) / 1000;
		stops.push(
			`rgb(${channel(r)} ${channel(g)} ${channel(b)} / ${alpha}) ${Math.round(radius * 1000) / 10}%`
		);
	}
	return `radial-gradient(circle closest-side at 50% 50%, ${stops.join(', ')})`;
}

export function fieldWheel(scheme: Scheme): string {
	const l = LADDERS[scheme].field;
	const steps = 36;
	const stops: string[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const hue = angleToHue(t * 360);
		stops.push(
			`${oklch(l, maxChroma(hue, l) * FIELD_CHROMA, hue)} ${Math.round(t * 3600) / 10}deg`
		);
	}
	return `conic-gradient(from 0deg at 50% 50%, ${stops.join(', ')})`;
}

export function specChip(spec: ThemeSpec, scheme: Scheme): string {
	const colors = samplePalette(spec).map((s) => nodeSwatch(s, scheme));
	if (colors.length === 1) return `linear-gradient(${colors[0]}, ${colors[0]})`;
	const stops = colors.map((c, i) => `${c} ${Math.round((i / (colors.length - 1)) * 100)}%`);
	return `linear-gradient(135deg, ${stops.join(', ')})`;
}
