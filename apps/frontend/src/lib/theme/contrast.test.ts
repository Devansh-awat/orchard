import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastOver, hexToOklch } from './color';
import {
	CONTRAST,
	deriveSimpleColors,
	generateThemeColors,
	hoverChecks,
	readabilityChecks,
	type ThemeColors
} from './generate';
import { PALETTE_PRESETS, sanitizeSpec, type Scheme, type ThemeSpec } from './spec';

const SCHEMES: Scheme[] = ['light', 'dark'];

function assertReadable(colors: ThemeColors, label: string) {
	for (const check of readabilityChecks()) {
		for (const bg of [check.anchor, ...(check.also ?? [])]) {
			const ratio = contrastOver(colors[check.fg], colors[bg], check.alpha ?? 1);
			assert.ok(
				ratio >= CONTRAST.text,
				`${label}: ${check.fg} (${colors[check.fg]}) on ${bg} (${colors[bg]}) is ${ratio.toFixed(2)}:1`
			);
		}
	}
}

// A hover that brightens an already-light panel reads as a hole rather than a
// highlight, which is how it looked before the fills were stepped off their own
// surface instead of read off the neutral ladder.
function assertHoverDirection(colors: ThemeColors, label: string) {
	for (const pair of hoverChecks()) {
		const baseL = hexToOklch(colors[pair.base]).l;
		const hoverL = hexToOklch(colors[pair.hover]).l;
		if (baseL > 0.5) {
			assert.ok(
				hoverL < baseL,
				`${label}: ${pair.hover} is lighter than ${pair.base} (${hoverL.toFixed(3)} vs ${baseL.toFixed(3)})`
			);
		} else {
			assert.ok(
				hoverL > baseL,
				`${label}: ${pair.hover} is darker than ${pair.base} (${hoverL.toFixed(3)} vs ${baseL.toFixed(3)})`
			);
		}
	}
}

function sweep(fn: (spec: ThemeSpec, scheme: Scheme) => void) {
	for (const scheme of SCHEMES) {
		for (let angle = 0; angle < 360; angle += 7) {
			for (const radius of [0, 0.1, 0.3, 0.55, 0.8, 1]) {
				for (const blend of [0, 0.35, 0.7, 1]) {
					for (const count of [1, 2, 3]) {
						fn(sanitizeSpec({ angle, radius, count, blend, grain: 0.5 }), scheme);
					}
				}
			}
		}
	}
}

test('every generated theme keeps text readable', () => {
	sweep((spec, scheme) => {
		const colors = generateThemeColors(deriveSimpleColors(spec, scheme), scheme === 'dark');
		const label = `${scheme} angle=${spec.angle} radius=${spec.radius}`;
		assertReadable(colors, label);
		assertHoverDirection(colors, label);
	});
});

test('shipped presets keep text readable', () => {
	for (const preset of PALETTE_PRESETS) {
		for (const scheme of SCHEMES) {
			const spec = sanitizeSpec(preset.spec);
			const colors = generateThemeColors(deriveSimpleColors(spec, scheme), scheme === 'dark');
			assertReadable(colors, `${preset.id} ${scheme}`);
			assertHoverDirection(colors, `${preset.id} ${scheme}`);
		}
	}
});

test('hand-picked colour overrides stay readable', () => {
	const samples = [
		'#000000',
		'#ffffff',
		'#808080',
		'#3b5f70',
		'#ffff00',
		'#00ff00',
		'#7c3aed',
		'#f5f5dc',
		'#123456'
	];
	for (const scheme of SCHEMES) {
		const base = deriveSimpleColors(sanitizeSpec({}), scheme);
		for (const accent of samples) {
			for (const background of samples) {
				const colors = generateThemeColors(
					{ ...base, accent, accentForeground: '#ffffff', background, card: background },
					scheme === 'dark'
				);
				assertReadable(colors, `${scheme} accent=${accent} bg=${background}`);
			}
		}
	}
});
