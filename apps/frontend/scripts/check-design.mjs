import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'design-baseline.json');
const UPDATE = process.argv.includes('--update');

const LEGACY_TOKENS =
	/var\(--(?:center-channel|sidebar-(?!animating)|mention-|online-indicator|away-indicator|dnd-indicator|control-(?:bg|hover-bg|text)|dropdown-(?:bg|border|hover-bg)|org-trigger|surface-(?:bg|border|muted)|card-bg|button-(?:bg|color)|error-text-color|link-color|new-message-separator|warning-(?:bg|border|text)|success-(?:bg|border|text|muted)|info-(?:bg|border|text))/g;

const LEGACY_CLASSES = new Set([
	'btn',
	'btn-primary',
	'btn-secondary',
	'btn-ghost',
	'btn-danger',
	'btn-sm',
	'card',
	'card-header',
	'card-body',
	'badge',
	'badge-success',
	'badge-warning',
	'badge-error',
	'badge-info',
	'badge-neutral',
	'input',
	'alert',
	'alert-error',
	'alert-warning',
	'alert-info',
	'alert-success',
	'dropdown',
	'dropdown-item',
	'skeleton'
]);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) walk(p, out);
		else if (entry.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function countHex(content) {
	return (content.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g) ?? []).length;
}

function countLegacyTokens(content) {
	return (content.match(LEGACY_TOKENS) ?? []).length;
}

const STATUS_TEXT_FILLS =
	/background(?:-color)?:\s*var\(--status-(?:success|error|warning|info|neutral|progress|deploy)\)/g;

function countStatusTextFills(content) {
	return (content.match(STATUS_TEXT_FILLS) ?? []).length;
}

function countLegacyClasses(content, file) {
	if (file.includes(`${join('lib', 'components', 'ui')}`)) return 0;
	let count = 0;
	for (const attr of content.matchAll(/class="([^"]*)"/g)) {
		for (const token of attr[1].split(/[\s{}]+/)) {
			if (LEGACY_CLASSES.has(token)) count++;
		}
	}
	return count;
}

const files = walk(SRC);
const totals = { hexColors: 0, legacyTokens: 0, legacyClasses: 0, statusTextFills: 0 };
const perFile = new Map();

for (const file of files) {
	const content = readFileSync(file, 'utf8');
	const counts = {
		hexColors: countHex(content),
		legacyTokens: countLegacyTokens(content),
		legacyClasses: countLegacyClasses(content, file),
		statusTextFills: countStatusTextFills(content)
	};
	totals.hexColors += counts.hexColors;
	totals.legacyTokens += counts.legacyTokens;
	totals.legacyClasses += counts.legacyClasses;
	totals.statusTextFills += counts.statusTextFills;
	if (counts.hexColors || counts.legacyTokens || counts.legacyClasses || counts.statusTextFills) {
		perFile.set(relative(ROOT, file), counts);
	}
}

if (UPDATE || !existsSync(BASELINE_PATH)) {
	writeFileSync(BASELINE_PATH, `${JSON.stringify(totals, null, '\t')}\n`);
	console.log(`design baseline written: ${JSON.stringify(totals)}`);
	process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
let failed = false;
let improved = false;

for (const key of Object.keys(totals)) {
	const was = baseline[key] ?? 0;
	const now = totals[key];
	if (now > was) {
		failed = true;
		console.error(`✗ ${key}: ${now} (baseline ${was}) — new debt added`);
		const offenders = [...perFile.entries()]
			.filter(([, c]) => c[key] > 0)
			.sort((a, b) => b[1][key] - a[1][key])
			.slice(0, 10);
		for (const [file, c] of offenders) console.error(`    ${c[key]}\t${file}`);
	} else if (now < was) {
		improved = true;
		console.log(`✓ ${key}: ${now} (baseline ${was}) — improved`);
	} else {
		console.log(`✓ ${key}: ${now}`);
	}
}

if (failed) {
	console.error(
		'\ndesign check failed: use semantic tokens (src/lib/design/tokens.css), ui/ components,'
	);
	console.error(
		'solid fills from --status-*-solid with --on-solid text (never a status text token),'
	);
	console.error('and ui/status.ts instead. See apps/frontend/DESIGN.md.');
	process.exit(1);
}

if (improved) {
	console.log('\nbaseline can be tightened: pnpm check:design --update');
}
