export type Oklch = { l: number; c: number; h: number };
export type Rgb = { r: number; g: number; b: number };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function clamp(v: number, min: number, max: number): number {
	return v < min ? min : v > max ? max : v;
}

function linearToSrgb(x: number): number {
	return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbToLinear(x: number): number {
	return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function oklabToLinearSrgb(L: number, a: number, b: number): Rgb {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;

	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;

	return {
		r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	};
}

function linearSrgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);

	return {
		L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
	};
}

function inGamut({ r, g, b }: Rgb): boolean {
	const e = 0.0001;
	return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e;
}

export function gamutMap({ l, c, h }: Oklch): Oklch {
	const L = clamp01(l);
	const rad = (h * Math.PI) / 180;
	const toRgb = (chroma: number) =>
		oklabToLinearSrgb(L, chroma * Math.cos(rad), chroma * Math.sin(rad));

	if (c <= 0 || inGamut(toRgb(c))) return { l: L, c: Math.max(c, 0), h };

	let lo = 0;
	let hi = c;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(toRgb(mid))) lo = mid;
		else hi = mid;
	}
	return { l: L, c: lo, h };
}

export function oklchToRgb(color: Oklch): Rgb {
	const { l, c, h } = gamutMap(color);
	const rad = (h * Math.PI) / 180;
	const lin = oklabToLinearSrgb(l, c * Math.cos(rad), c * Math.sin(rad));
	return {
		r: clamp01(linearToSrgb(lin.r)),
		g: clamp01(linearToSrgb(lin.g)),
		b: clamp01(linearToSrgb(lin.b))
	};
}

export function rgbToHex({ r, g, b }: Rgb): string {
	const to = (v: number) =>
		Math.round(clamp01(v) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${to(r)}${to(g)}${to(b)}`;
}

export function oklch(l: number, c: number, h: number): string {
	return rgbToHex(oklchToRgb({ l, c, h }));
}

export function hexToRgb(hex: string): Rgb {
	let h = hex.trim().replace('#', '');
	if (h.length === 3 || h.length === 4) {
		h = h
			.slice(0, 3)
			.split('')
			.map((ch) => ch + ch)
			.join('');
	}
	if (h.length === 8) h = h.slice(0, 6);
	if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
	return {
		r: parseInt(h.slice(0, 2), 16) / 255,
		g: parseInt(h.slice(2, 4), 16) / 255,
		b: parseInt(h.slice(4, 6), 16) / 255
	};
}

export function hexToOklch(hex: string): Oklch {
	const { r, g, b } = hexToRgb(hex);
	const lab = linearSrgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
	const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
	let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
	if (h < 0) h += 360;
	return { l: lab.L, c, h };
}

export function luminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function oklchAlpha(l: number, c: number, h: number, alpha: number): string {
	const { r, g, b } = oklchToRgb({ l, c, h });
	const to = (v: number) => Math.round(clamp01(v) * 255);
	return `rgb(${to(r)} ${to(g)} ${to(b)} / ${Math.round(clamp01(alpha) * 1000) / 1000})`;
}

export function mixHex(a: string, b: string, weight: number): string {
	const w = clamp01(weight);
	const ca = hexToRgb(a);
	const cb = hexToRgb(b);
	return rgbToHex({
		r: ca.r * w + cb.r * (1 - w),
		g: ca.g * w + cb.g * (1 - w),
		b: ca.b * w + cb.b * (1 - w)
	});
}
