import { clamp, gamutMap } from './color';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

export type ThemeSpec = {
	angle: number;
	radius: number;
	count: number;
	blend: number;
	grain: number;
};

export type ThemeNode = {
	x: number;
	y: number;
	hue: number;
	vividness: number;
};

export const MAX_NODES = 3;
export const MIN_NODES = 1;

const HUE_ORIGIN = 95;
const VIVID_EXP = 0.7;

export function vividnessFor(radius: number): number {
	return Math.pow(clamp(radius, 0, 1), VIVID_EXP);
}

export function radiusFor(vividness: number): number {
	return Math.pow(clamp(vividness, 0, 1), 1 / VIVID_EXP);
}

const FANS: Record<number, number[]> = {
	1: [0],
	2: [0, 180],
	3: [0, 120, -120]
};

export function angleToHue(angle: number): number {
	return (((HUE_ORIGIN + angle) % 360) + 360) % 360;
}

export function hueToAngle(hue: number): number {
	return (((hue - HUE_ORIGIN) % 360) + 360) % 360;
}

export function specNodes(spec: ThemeSpec): ThemeNode[] {
	const count = clamp(Math.round(spec.count), MIN_NODES, MAX_NODES);
	const radius = clamp(spec.radius, 0, 1);
	const fan = FANS[count];
	const nodes: ThemeNode[] = [];
	for (let i = 0; i < count; i++) {
		const angle = spec.angle + fan[i];
		const rad = (angle * Math.PI) / 180;
		nodes.push({
			x: 0.5 + Math.cos(rad) * radius * 0.5,
			y: 0.5 + Math.sin(rad) * radius * 0.5,
			hue: angleToHue(angle),
			vividness: vividnessFor(radius)
		});
	}
	return nodes;
}

export function polarFromPoint(x: number, y: number): { angle: number; radius: number } {
	const dx = (x - 0.5) * 2;
	const dy = (y - 0.5) * 2;
	const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
	return { angle, radius: clamp(Math.hypot(dx, dy), 0, 1) };
}

export function maxChroma(hue: number, l: number): number {
	return gamutMap({ l, c: 0.45, h: hue }).c;
}

export function sanitizeSpec(input: Partial<ThemeSpec> | null | undefined): ThemeSpec {
	const angle = Number(input?.angle);
	const radius = Number(input?.radius);
	const count = Number(input?.count);
	return {
		angle: Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : hueToAngle(20),
		radius: Number.isFinite(radius) ? clamp(radius, 0, 1) : radiusFor(0.864),
		count: Number.isFinite(count) ? clamp(Math.round(count), MIN_NODES, MAX_NODES) : 1,
		blend: clamp(Number(input?.blend ?? 0.35), 0, 1),
		grain: clamp(Number(input?.grain ?? 0), 0, 1)
	};
}

export function specsEqual(a: ThemeSpec, b: ThemeSpec): boolean {
	const near = (x: number, y: number) => Math.abs(x - y) < 0.004;
	const nearAngle = (x: number, y: number) => {
		const d = Math.abs(((x - y) % 360) + 360) % 360;
		return Math.min(d, 360 - d) < 0.6;
	};
	return (
		a.count === b.count &&
		nearAngle(a.angle, b.angle) &&
		near(a.radius, b.radius) &&
		near(a.blend, b.blend) &&
		near(a.grain, b.grain)
	);
}

export function moveConstellation(spec: ThemeSpec, dx: number, dy: number): ThemeSpec {
	const rad = (spec.angle * Math.PI) / 180;
	const x = 0.5 + Math.cos(rad) * spec.radius * 0.5 + dx;
	const y = 0.5 + Math.sin(rad) * spec.radius * 0.5 + dy;
	return { ...spec, ...polarFromPoint(x, y) };
}

export function setNodeCount(spec: ThemeSpec, count: number): ThemeSpec {
	return { ...spec, count: clamp(Math.round(count), MIN_NODES, MAX_NODES) };
}

export function addNode(spec: ThemeSpec): ThemeSpec {
	return setNodeCount(spec, spec.count + 1);
}

export function removeNode(spec: ThemeSpec): ThemeSpec {
	return setNodeCount(spec, spec.count - 1);
}

export type PalettePreset = {
	id: string;
	name: string;
	spec: ThemeSpec;
};

const preset = (
	id: string,
	name: string,
	hue: number,
	vividness: number,
	count: number,
	blend: number,
	grain: number
): PalettePreset => ({
	id,
	name,
	spec: sanitizeSpec({ angle: hueToAngle(hue), radius: radiusFor(vividness), count, blend, grain })
});

export const PALETTE_PRESETS: PalettePreset[] = [
	preset('orchard', 'Orchard', 20, 0.864, 1, 0.14, 0),
	preset('paper', 'Paper', 55, 0.42, 1, 0.5, 0.2),
	preset('cream', 'Cream', 24, 0.68, 2, 0.55, 0.14),
	preset('sunset', 'Sunset', 12, 0.82, 3, 0.6, 0.08),
	preset('orchid', 'Orchid', 312, 0.76, 3, 0.6, 0),
	preset('lagoon', 'Lagoon', 196, 0.7, 2, 0.5, 0),
	preset('forest', 'Forest', 148, 0.66, 2, 0.48, 0.1),
	preset('midnight', 'Midnight', 252, 0.74, 2, 0.4, 0),
	preset('electric', 'Electric', 178, 0.92, 3, 0.45, 0),
	preset('slate', 'Slate', 245, 0.2, 1, 0.45, 0),
	preset('mono', 'Mono', 20, 0, 1, 0, 0.16)
];

export const DEFAULT_PRESET_ID = 'orchard';

export function presetById(id: string | null | undefined): PalettePreset | null {
	if (!id) return null;
	return PALETTE_PRESETS.find((p) => p.id === id) ?? null;
}

export function matchPresetId(spec: ThemeSpec): string | null {
	return PALETTE_PRESETS.find((p) => specsEqual(p.spec, spec))?.id ?? null;
}
