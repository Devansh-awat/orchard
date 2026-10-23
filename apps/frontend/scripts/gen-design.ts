import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	EXIT_BOUNCE,
	EXIT_SCALE,
	SPRINGS,
	sampleSpring,
	type SpringSpec
} from '../src/lib/design/springs';
import { generateScales } from '../src/lib/theme/scales';
import { DEFAULT_PRESET_ID, presetById } from '../src/lib/theme/spec';

const DESIGN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'design');
const MAX_POINTS = 40;

function simplify(points: number[]): string[] {
	const stride = Math.max(1, Math.ceil(points.length / MAX_POINTS));
	const kept: string[] = [];
	for (let i = 0; i < points.length; i += stride) {
		const pct = ((i / (points.length - 1)) * 100).toFixed(1);
		kept.push(`${Number(points[i].toFixed(4))} ${pct}%`);
	}
	kept[0] = '0';
	kept.push('1');
	return kept;
}

function curve(spec: SpringSpec) {
	const { points, durationMs } = sampleSpring(spec);
	return { easing: `linear(${simplify(points).join(', ')})`, durationMs };
}

const lines: string[] = [':root {'];
for (const [name, spec] of Object.entries(SPRINGS)) {
	const enter = curve(spec);
	const exit = curve({
		visualDuration: spec.visualDuration * EXIT_SCALE,
		bounce: spec.bounce + EXIT_BOUNCE
	});
	lines.push(`\t--spring-${name}: ${enter.easing};`);
	lines.push(`\t--spring-${name}-duration: ${enter.durationMs}ms;`);
	lines.push(`\t--spring-${name}-exit: ${exit.easing};`);
	lines.push(`\t--spring-${name}-exit-duration: ${exit.durationMs}ms;`);
}
lines.push('}', '');
lines.push(
	'html.motion-reduce {',
	...Object.keys(SPRINGS).flatMap((name) => [
		`\t--spring-${name}: ease;`,
		`\t--spring-${name}-duration: 260ms;`,
		`\t--spring-${name}-exit: ease;`,
		`\t--spring-${name}-exit-duration: 260ms;`
	]),
	'}',
	''
);
writeFileSync(join(DESIGN, 'springs.css'), lines.join('\n'));

const spec = presetById(DEFAULT_PRESET_ID)!.spec;
const block = (selector: string, scheme: 'light' | 'dark') =>
	[
		`${selector} {`,
		...Object.entries(generateScales(spec, scheme)).map(([k, v]) => `\t${k}: ${v};`),
		'}'
	].join('\n');
writeFileSync(
	join(DESIGN, 'scales.css'),
	[block(':root', 'light'), '', block(':root.dark', 'dark'), ''].join('\n')
);
