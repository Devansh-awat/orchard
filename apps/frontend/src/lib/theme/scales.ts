import { clamp, contrastOver, ensureContrastAll, fitBackground, hexToOklch, oklch } from './color';
import { composePalette, type ComposedPalette, type SimpleThemeColors } from './generate';
import { maxChroma, specNodes, type Scheme, type ThemeSpec } from './spec';

export const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const HUE_SCALES = ['accent', 'red', 'amber', 'green', 'blue'] as const;
export const NEUTRAL_SCALES = ['neutral'] as const;

export type HueScale = (typeof HUE_SCALES)[number];
export type NeutralScale = (typeof NEUTRAL_SCALES)[number];
export type ScaleVars = Record<string, string>;

export const TEXT_TARGET = 4.5;
export const FAINT_TARGET = 3;

type Tone = { l: number; c: number };
type NeutralLadder = { steps: Tone[]; app: Tone; surface: Tone; raised: Tone };

const NEUTRAL: Record<Scheme, NeutralLadder> = {
	light: {
		app: { l: 0.972, c: 0.007 },
		surface: { l: 0.997, c: 0.003 },
		raised: { l: 0.999, c: 0.002 },
		steps: [
			{ l: 0.962, c: 0.008 },
			{ l: 0.942, c: 0.01 },
			{ l: 0.922, c: 0.011 },
			{ l: 0.902, c: 0.011 },
			{ l: 0.86, c: 0.011 },
			{ l: 0.78, c: 0.01 },
			{ l: 0.67, c: 0.01 },
			{ l: 0.6, c: 0.01 },
			{ l: 0.52, c: 0.012 },
			{ l: 0.23, c: 0.01 }
		]
	},
	dark: {
		app: { l: 0.16, c: 0.014 },
		surface: { l: 0.205, c: 0.011 },
		raised: { l: 0.24, c: 0.011 },
		steps: [
			{ l: 0.235, c: 0.012 },
			{ l: 0.26, c: 0.013 },
			{ l: 0.29, c: 0.014 },
			{ l: 0.31, c: 0.014 },
			{ l: 0.37, c: 0.014 },
			{ l: 0.47, c: 0.013 },
			{ l: 0.62, c: 0.012 },
			{ l: 0.58, c: 0.012 },
			{ l: 0.74, c: 0.012 },
			{ l: 0.95, c: 0.008 }
		]
	}
};

type HueLadder = { l: number[]; c: number[] };

const HUE: Record<Scheme, HueLadder> = {
	light: {
		l: [0.975, 0.955, 0.93, 0.89, 0.83, 0.76, 0.6, 0.54, 0.5, 0.3],
		c: [0.45, 0.6, 0.7, 0.75, 0.8, 0.88, 1, 1, 0.95, 0.7]
	},
	dark: {
		l: [0.22, 0.25, 0.29, 0.34, 0.41, 0.49, 0.64, 0.7, 0.8, 0.94],
		c: [0.4, 0.45, 0.5, 0.58, 0.65, 0.72, 0.92, 0.9, 0.72, 0.36]
	}
};

const SOLID_LIGHTNESS: Partial<Record<HueScale, Record<Scheme, number>>> = {
	amber: { light: 0.8, dark: 0.8 }
};

const STATUS_HUE: Record<Exclude<HueScale, 'accent'>, number> = {
	red: 25,
	amber: 75,
	green: 152,
	blue: 255
};

function meanHue(hues: number[]): number {
	if (hues.length === 1) return hues[0];
	let sx = 0;
	let sy = 0;
	for (const h of hues) {
		sx += Math.cos((h * Math.PI) / 180);
		sy += Math.sin((h * Math.PI) / 180);
	}
	if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return hues[0];
	return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

const CHROME_MIX: Record<Scheme, string> = { light: '84%', dark: '86%' };

function neutralScale(palette: ComposedPalette, scheme: Scheme): Record<string, string> {
	const ladder = NEUTRAL[scheme];
	const { colors } = palette;
	const ground = hexToOklch(colors.centerChannelBg);
	const card = hexToOklch(colors.cardBg);
	const tint = clamp(ground.c / ladder.app.c, 0, 4);
	const hue = ground.c < 0.002 ? card.h : ground.h;
	const lift = card.l - ladder.surface.l;
	const at = ({ l, c }: Tone, shift: number) => {
		const shifted = clamp(l + shift, 0.02, 0.999);
		return oklch(shifted, Math.min(c * tint, maxChroma(hue, shifted)), hue);
	};
	const raisedL = clamp(card.l + ladder.raised.l - ladder.surface.l, 0.02, 0.999);
	const out: Record<string, string> = {
		app: colors.centerChannelBg,
		surface: colors.cardBg,
		raised: oklch(raisedL, Math.min(card.c, maxChroma(card.h, raisedL)), card.h)
	};
	ladder.steps.forEach((tone, i) => (out[String(i + 1)] = at(tone, i < 6 ? lift : lift / 2)));
	out['9'] = colors.surfaceMuted;
	out['10'] = colors.centerChannelColor;
	return out;
}

function pinnedTone(hex: string): { hue: number; vividness: number } {
	const { l, c, h } = hexToOklch(hex);
	const ceiling = maxChroma(h, l);
	return { hue: h, vividness: ceiling > 0 ? clamp(c / ceiling, 0, 1) : 0 };
}

function hueScale(
	hue: number,
	vividness: number,
	scheme: Scheme,
	solid?: number
): Record<string, string> {
	const ladder = HUE[scheme];
	const out: Record<string, string> = {};
	ladder.l.forEach((base, i) => {
		const l = solid !== undefined && (i === 6 || i === 7) ? solid + (i === 7 ? -0.05 : 0) : base;
		out[String(i + 1)] = oklch(l, maxChroma(hue, l) * clamp(vividness * ladder.c[i], 0, 1), hue);
	});
	return out;
}

function readableOn(fill: string): string {
	const white = '#ffffff';
	const ink = oklch(0.2, 0.012, hexToOklch(fill).h);
	return contrastOver(white, fill) >= contrastOver(ink, fill) ? white : ink;
}

function enforce(
	scale: Record<string, string>,
	grounds: string[],
	scheme: Scheme
): Record<string, string> {
	const own = [scale['1'], scale['2'], scale['3']];
	const out = { ...scale };
	out['9'] = ensureContrastAll(out['9'], [...grounds, ...own], TEXT_TARGET);
	out['10'] = ensureContrastAll(out['10'], [...grounds, ...own], TEXT_TARGET + 2);
	if (scheme === 'dark') out['8'] = ensureContrastAll(out['8'], grounds, FAINT_TARGET);
	return out;
}

export function paletteHues(spec: ThemeSpec): {
	accent: number;
	vividness: number;
	neutral: number;
} {
	const nodes = specNodes(spec);
	return {
		accent: nodes[0].hue,
		vividness: nodes[0].vividness,
		neutral: meanHue(nodes.map((n) => n.hue))
	};
}

const STATUS_PIN: Record<Exclude<HueScale, 'accent' | 'blue'>, keyof SimpleThemeColors> = {
	red: 'error',
	amber: 'warning',
	green: 'success'
};

export function generateScales(
	spec: ThemeSpec,
	scheme: Scheme,
	palette: ComposedPalette = composePalette(spec, scheme)
): ScaleVars {
	const { accent, vividness } = paletteHues(spec);
	const { simple, colors, pinned } = palette;

	const neutrals: Record<NeutralScale, Record<string, string>> = {
		neutral: neutralScale(palette, scheme)
	};

	const vars: ScaleVars = {};

	for (const name of NEUTRAL_SCALES) {
		const scale = neutrals[name];
		const grounds = [scale.app, scale.surface, scale.raised];
		const fitted = { ...scale };
		if (!pinned.has('muted')) {
			fitted['9'] = ensureContrastAll(
				scale['9'],
				[...grounds, scale['1'], scale['2'], scale['3']],
				TEXT_TARGET
			);
		}
		if (!pinned.has('foreground')) {
			fitted['10'] = ensureContrastAll(
				scale['10'],
				[...grounds, scale['1'], scale['2'], scale['3']],
				TEXT_TARGET + 3
			);
		}
		fitted['8'] = ensureContrastAll(scale['8'], grounds, FAINT_TARGET);
		for (const [step, value] of Object.entries(fitted)) vars[`--${name}-${step}`] = value;
	}

	vars['--neutral-border'] = colors.surfaceBorder;
	const sidebarPinned = pinned.has('sidebarBackground');
	vars['--neutral-chrome'] = sidebarPinned
		? colors.sidebarBg
		: scheme === 'dark'
			? neutrals.neutral.raised
			: neutrals.neutral.surface;
	vars['--neutral-chrome-mix'] = sidebarPinned ? '100%' : CHROME_MIX[scheme];

	const grounds = NEUTRAL_SCALES.flatMap((n) => [
		neutrals[n].app,
		neutrals[n].surface,
		neutrals[n].raised
	]);

	for (const name of HUE_SCALES) {
		const pin = name === 'accent' ? 'accent' : name === 'blue' ? null : STATUS_PIN[name];
		const pinnedHex = pin && pinned.has(pin) ? simple[pin] : null;
		const base = pinnedHex
			? pinnedTone(pinnedHex)
			: name === 'accent'
				? { hue: accent, vividness }
				: { hue: STATUS_HUE[name], vividness: 0.9 };
		const scale = enforce(
			hueScale(base.hue, base.vividness, scheme, SOLID_LIGHTNESS[name]?.[scheme]),
			grounds,
			scheme
		);
		if (pinnedHex && name === 'accent') scale['7'] = pinnedHex;
		if (pinnedHex && name !== 'accent') scale['9'] = pinnedHex;
		const contrast =
			name === 'accent' && pinned.has('accentForeground')
				? simple.accentForeground
				: readableOn(scale['7']);
		if (!(pinnedHex && name === 'accent')) {
			scale['7'] = fitBackground(scale['7'], [{ hex: contrast }], TEXT_TARGET);
		}
		scale['8'] = fitBackground(scale['8'], [{ hex: contrast }], TEXT_TARGET);
		for (const [step, value] of Object.entries(scale)) vars[`--${name}-${step}`] = value;
		vars[`--${name}-contrast`] = contrast;
		const solid = fitBackground(scale['7'], [{ hex: '#ffffff' }], TEXT_TARGET);
		const { l, c, h } = hexToOklch(solid);
		vars[`--${name}-solid`] = solid;
		vars[`--${name}-solid-hover`] = oklch(Math.max(0.05, l - 0.045), c, h);
	}

	return vars;
}
