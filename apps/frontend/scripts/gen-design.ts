import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EASE, FADE, SPRINGS, TEMPO, exitSpec, springCurve } from '../src/lib/design/springs';
import { generateScales } from '../src/lib/theme/scales';
import { DEFAULT_PRESET_ID, presetById } from '../src/lib/theme/spec';

const DESIGN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'design');
const timed = (ms: number) => `calc(${ms}ms * var(--tempo))`;
const lines: string[] = [':root {', `\t--tempo: ${TEMPO};`];
for (const [name, value] of Object.entries(EASE)) {
	lines.push(`\t--curve-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`);
}
for (const [name, ms] of Object.entries(FADE)) {
	lines.push(`\t--fade-${name}: ${timed(ms)};`);
}
for (const [name, spec] of Object.entries(SPRINGS)) {
	const enter = springCurve(spec, 40, 1);
	const exit = springCurve(exitSpec(spec), 40, 1);
	lines.push(`\t--spring-${name}: ${enter.easing};`);
	lines.push(`\t--spring-${name}-duration: ${timed(enter.durationMs)};`);
	lines.push(`\t--spring-${name}-exit: ${exit.easing};`);
	lines.push(`\t--spring-${name}-exit-duration: ${timed(exit.durationMs)};`);
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
