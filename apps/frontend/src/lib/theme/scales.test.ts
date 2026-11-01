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
import { composePalette } from './generate';
import { LEGACY_THEMES } from './legacy';
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

test('pinned colours paint exactly and derived steps stay readable', () => {
	for (const theme of LEGACY_THEMES) {
		const vars = generateScales(
			theme.spec,
			theme.mode,
			composePalette(theme.spec, theme.mode, theme.colours)
		);
		const label = `classic ${theme.id}`;
		assert.equal(vars['--neutral-app'], theme.colours.background, `${label}: app`);
		assert.equal(vars['--neutral-surface'], theme.colours.card, `${label}: surface`);
		assert.equal(vars['--neutral-10'], theme.colours.foreground, `${label}: ink`);
		assert.equal(vars['--neutral-9'], theme.colours.muted, `${label}: muted`);
		assert.equal(vars['--neutral-border'], theme.colours.border, `${label}: border`);
		assert.equal(vars['--neutral-chrome'], theme.colours.sidebarBackground, `${label}: chrome`);
		assert.equal(vars['--accent-7'], theme.colours.accent, `${label}: accent`);
		assertOrdered(vars, label, theme.mode);
		for (const ground of ['app', 'surface', 'raised']) {
			const faint = ratio(vars, '--neutral-8', `--neutral-${ground}`);
			assert.ok(faint >= FAINT_TARGET, `${label}: --neutral-8 on ${ground} is ${faint.toFixed(2)}`);
		}
	}
});

test('a pinned black background keeps derived surfaces neutral', () => {
	const spec = sanitizeSpec({ angle: 0, radius: 1, count: 1, blend: 1, grain: 0 });
	const vars = generateScales(
		spec,
		'dark',
		composePalette(spec, 'dark', { background: '#000000' })
	);
	assert.equal(vars['--neutral-app'], '#000000');
	for (const step of ['1', '2', '3', '4', '5']) {
		const { c } = hexToOklch(vars[`--neutral-${step}`]);
		assert.ok(c < 0.004, `--neutral-${step} is tinted (chroma ${c.toFixed(4)})`);
	}
	for (const ground of ['app', '1', '2', '3']) {
		const fg = ratio(vars, '--neutral-10', `--neutral-${ground}`);
		assert.ok(fg >= TEXT_TARGET + 3, `--neutral-10 on ${ground} is ${fg.toFixed(2)}`);
	}
});
