import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastOver, hexToOklch } from './color';
import {
	FAINT_TARGET,
	HUE_SCALES,
	NEUTRAL_SCALES,
	TEXT_TARGET,
	generateScales,
	type ScaleVars
} from './scales';
import { PALETTE_PRESETS, sanitizeSpec, type Scheme, type ThemeSpec } from './spec';

const SCHEMES: Scheme[] = ['light', 'dark'];

function ratio(vars: ScaleVars, fg: string, bg: string) {
	return contrastOver(vars[fg], vars[bg]);
}

function assertScales(vars: ScaleVars, label: string) {
	for (const n of NEUTRAL_SCALES) {
		for (const ground of ['app', 'surface', 'raised', '1', '2', '3']) {
			const bg = `--${n}-${ground}`;
			const muted = ratio(vars, `--${n}-9`, bg);
			assert.ok(muted >= TEXT_TARGET, `${label}: --${n}-9 on ${bg} is ${muted.toFixed(2)}`);
			const fg = ratio(vars, `--${n}-10`, bg);
			assert.ok(fg >= TEXT_TARGET + 3, `${label}: --${n}-10 on ${bg} is ${fg.toFixed(2)}`);
		}
		for (const ground of ['app', 'surface', 'raised']) {
			const faint = ratio(vars, `--${n}-8`, `--${n}-${ground}`);
			assert.ok(faint >= FAINT_TARGET, `${label}: --${n}-8 on ${ground} is ${faint.toFixed(2)}`);
		}
	}
	for (const h of HUE_SCALES) {
		for (const step of ['7', '8']) {
			const r = ratio(vars, `--${h}-contrast`, `--${h}-${step}`);
			assert.ok(r >= TEXT_TARGET, `${label}: --${h}-contrast on --${h}-${step} is ${r.toFixed(2)}`);
		}
		for (const step of ['solid', 'solid-hover']) {
			const r = contrastOver('#ffffff', vars[`--${h}-${step}`]);
			assert.ok(r >= TEXT_TARGET, `${label}: white on --${h}-${step} is ${r.toFixed(2)}`);
		}
		for (const n of NEUTRAL_SCALES) {
			for (const ground of ['app', 'surface', 'raised']) {
				const r = ratio(vars, `--${h}-9`, `--${n}-${ground}`);
				assert.ok(r >= TEXT_TARGET, `${label}: --${h}-9 on --${n}-${ground} is ${r.toFixed(2)}`);
			}
		}
		for (const ground of ['1', '2', '3']) {
			const r = ratio(vars, `--${h}-9`, `--${h}-${ground}`);
			assert.ok(r >= TEXT_TARGET, `${label}: --${h}-9 on --${h}-${ground} is ${r.toFixed(2)}`);
		}
	}
}

function assertOrdered(vars: ScaleVars, label: string, scheme: Scheme) {
	for (const n of NEUTRAL_SCALES) {
		const l = (k: string) => hexToOklch(vars[`--${n}-${k}`]).l;
		const dir = scheme === 'light' ? -1 : 1;
		for (const [a, b] of [
			['1', '2'],
			['2', '3'],
			['3', '4'],
			['4', '5']
		]) {
			assert.ok((l(b) - l(a)) * dir > 0, `${label}: --${n}-${b} does not step past --${n}-${a}`);
		}
	}
}

function sweep(fn: (spec: ThemeSpec, scheme: Scheme) => void) {
	for (const scheme of SCHEMES) {
		for (let angle = 0; angle < 360; angle += 11) {
			for (const radius of [0, 0.3, 0.8, 1]) {
				for (const blend of [0, 0.5, 1]) {
					for (const count of [1, 3]) {
						fn(sanitizeSpec({ angle, radius, count, blend, grain: 0 }), scheme);
					}
				}
			}
		}
	}
}

test('every preset scale is readable', () => {
	for (const preset of PALETTE_PRESETS) {
		for (const scheme of SCHEMES) {
			const vars = generateScales(preset.spec, scheme);
			assertScales(vars, `${preset.id}/${scheme}`);
			assertOrdered(vars, `${preset.id}/${scheme}`, scheme);
		}
	}
});

test('every point on the wheel yields readable scales', () => {
	sweep((spec, scheme) => {
		const vars = generateScales(spec, scheme);
		assertScales(vars, `${JSON.stringify(spec)}/${scheme}`);
	});
});
