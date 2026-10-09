import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CHAT_HARNESS_URL ?? 'http://localhost:3111';
const CHANNEL = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = resolve(
	process.env.CHAT_SHOT_DIR ??
		join(HERE, '..', '..', '..', '..', '.context', 'greenhouse', 'screens')
);
const VIEWS = ['busy', 'idle', 'slash', 'comment', 'plan', 'unreachable', 'long'];
const WIDTHS = [1100, 1512];
const HEIGHT = 945;
const TURN_GAP = 32;
const TOLERANCE = 1;
const GUTTER = 32;
const MIN_INSET = 16;
const WIDE_INSET = 24;
const WIDE_PANE = 768;

function measure() {
	const pane = document.querySelector('[data-testid="chat-pane"]');
	if (!pane) return { missing: true };
	const shown = (el) => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
	};
	const label = (el) => {
		const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
		const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
		return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}"`;
	};
	const edges = (selector, side) =>
		[...pane.querySelectorAll(selector)].filter(shown).map((el) => ({
			x: Math.round(el.getBoundingClientRect()[side] * 10) / 10,
			el: label(el)
		}));
	const typeIssues = [];
	const roots = [...pane.querySelectorAll('.tx, .chat-dock')];
	for (const root of roots) {
		const all = [root, ...root.querySelectorAll('*')];
		for (const el of all) {
			if (!shown(el)) continue;
			const direct = [...el.childNodes].some(
				(n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0
			);
			const field = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
			if (!direct && !field) continue;
			const cs = getComputedStyle(el);
			const size = parseFloat(cs.fontSize);
			const lh = cs.lineHeight === 'normal' ? NaN : parseFloat(cs.lineHeight);
			const problems = [];
			if (!Number.isFinite(size) || ![11, 12, 13, 15].includes(Math.round(size * 100) / 100)) {
				problems.push(`font-size ${cs.fontSize}`);
			}
			if (!Number.isFinite(lh) || Math.abs(lh / 4 - Math.round(lh / 4)) > 0.01) {
				problems.push(`line-height ${cs.lineHeight}`);
			}
			if (!['400', '600'].includes(cs.fontWeight)) problems.push(`weight ${cs.fontWeight}`);
			if (cs.fontStyle === 'italic' && !el.closest('.md em, .md i')) problems.push('italic');
			if (problems.length > 0) typeIssues.push(`${label(el)}: ${problems.join(', ')}`);
		}
	}
	const chunks = [...pane.querySelectorAll('[data-chunk]')].filter(shown);
	const gaps = [];
	for (let i = 1; i < chunks.length; i += 1) {
		const prev = chunks[i - 1].getBoundingClientRect();
		const next = chunks[i].getBoundingClientRect();
		gaps.push(Math.round((next.top - prev.bottom) * 10) / 10);
	}
	const col = pane.querySelector('.tx-col');
	const dock = pane.querySelector('.chat-dock .chat-col');
	const paneLeft = pane.getBoundingClientRect().left;
	const glyphs = [...pane.querySelectorAll('.turn-mark > *, .hm-avatar, .prep-mark > *')]
		.filter(shown)
		.map((el) => ({
			x: Math.round((el.getBoundingClientRect().left - paneLeft) * 10) / 10,
			el: label(el)
		}));
	const chatPane = pane.querySelector('.chat') ?? pane;
	return {
		missing: false,
		content: edges('[data-align="content"]', 'left'),
		own: edges('[data-align="own"]', 'right'),
		step: edges('[data-align="step"]', 'left'),
		typeIssues,
		gaps,
		columns: {
			transcript: col ? col.getBoundingClientRect().left : null,
			dock: dock ? dock.getBoundingClientRect().left : null
		},
		inset: {
			pad: col ? parseFloat(getComputedStyle(col).paddingLeft) : null,
			paneWidth: chatPane.getBoundingClientRect().width,
			glyphs
		}
	};
}

function log(line) {
	process.stdout.write(`${line}\n`);
}

function distinct(values) {
	const groups = [];
	for (const v of values) {
		const hit = groups.find((g) => Math.abs(g.x - v.x) <= TOLERANCE);
		if (hit) hit.items.push(v.el);
		else groups.push({ x: v.x, items: [v.el] });
	}
	return groups;
}

async function main() {
	const browser = await chromium.launch({ channel: CHANNEL });
	const failures = [];
	const themes = SHOTS ? ['light', 'dark'] : ['light'];
	if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });
	for (const theme of themes) {
		const context = await browser.newContext({ deviceScaleFactor: SHOTS ? 2 : 1 });
		await context.addInitScript((mode) => {
			localStorage.setItem('theme', mode);
		}, theme);
		const page = await context.newPage();
		for (const width of WIDTHS) {
			await page.setViewportSize({ width, height: HEIGHT });
			for (const view of VIEWS) {
				const tag = `${view}@${width}${SHOTS ? ` ${theme}` : ''}`;
				await page.goto(`${BASE}/dev/chat-harness?view=${view}`, { waitUntil: 'networkidle' });
				await page.waitForSelector('[data-testid="chat-pane"]');
				await page.evaluate(() => document.fonts.ready);
				await page.waitForTimeout(400);
				const m = await page.evaluate(measure);
				if (SHOTS && width === 1512) {
					await page.screenshot({ path: join(SHOT_DIR, `chat2-${view}-${theme}.png`) });
				}
				const rows = page.locator('button.act-row:not([disabled])');
				const count = await rows.count();
				if (count > 0 && !m.missing) {
					for (let i = 0; i < count; i += 1) await rows.nth(i).click();
					await page.waitForTimeout(500);
					const open = await page.evaluate(measure);
					m.step = open.step;
					m.content = [...m.content, ...open.content];
					m.typeIssues = [...new Set([...m.typeIssues, ...open.typeIssues])];
					m.expanded = count;
					for (let i = 0; i < count; i += 1) await rows.nth(i).click();
					await page.waitForTimeout(400);
				}
				const problems = [];
				if (m.missing) problems.push('chat pane missing');
				else {
					const content = distinct(m.content);
					if (content.length > 1) {
						problems.push(
							`content edges ${content.map((g) => `${g.x}px [${g.items.slice(0, 3).join('; ')}]`).join(' | ')}`
						);
					}
					const own = distinct(m.own);
					if (own.length > 1) {
						problems.push(
							`own right edges ${own.map((g) => `${g.x}px [${g.items.slice(0, 3).join('; ')}]`).join(' | ')}`
						);
					}
					const step = distinct(m.step);
					if (step.length > 1) {
						problems.push(`step edges ${step.map((g) => `${g.x}px`).join(' | ')}`);
					}
					if (
						content.length === 1 &&
						step.length === 1 &&
						Math.abs(step[0].x - content[0].x - 16) > TOLERANCE
					) {
						problems.push(`steps indent ${step[0].x - content[0].x}px, expected 16`);
					}
					if (m.columns.transcript !== null && m.columns.dock !== null) {
						if (Math.abs(m.columns.transcript - m.columns.dock) > TOLERANCE) {
							problems.push(
								`transcript column ${m.columns.transcript} vs composer column ${m.columns.dock}`
							);
						}
					}
					if (m.inset.pad !== null) {
						const want = GUTTER + (m.inset.paneWidth >= WIDE_PANE ? WIDE_INSET : MIN_INSET);
						if (Math.abs(m.inset.pad - want) > TOLERANCE) {
							problems.push(`column inset ${m.inset.pad}px, expected ${want}px`);
						}
					}
					const tight = m.inset.glyphs.filter((g) => g.x < MIN_INSET - TOLERANCE);
					if (tight.length > 0) {
						problems.push(
							`gutter glyphs within ${MIN_INSET}px of the pane edge: ${tight
								.slice(0, 3)
								.map((g) => `${g.x}px ${g.el}`)
								.join('; ')}`
						);
					}
					const badGaps = m.gaps.filter((g) => Math.abs(g - TURN_GAP) > 0.5);
					if (badGaps.length > 0) problems.push(`turn gaps ${m.gaps.join(', ')}`);
					for (const issue of m.typeIssues) problems.push(issue);
				}
				const summary = m.missing
					? ''
					: `${distinct(m.content).length} content edge, ${distinct(m.own).length} own edge, ${distinct(m.step).length} step edge (${m.step.length} steps), ${m.gaps.length} turn gaps`;
				if (problems.length > 0) {
					failures.push({ tag, problems });
					log(`FAIL ${tag}`);
					for (const p of problems.slice(0, 12)) log(`     ${p}`);
					if (problems.length > 12) log(`     ...and ${problems.length - 12} more`);
				} else {
					log(`ok   ${tag}  ${summary}`);
				}
			}
		}
		await context.close();
	}
	await browser.close();
	if (failures.length > 0) {
		log(`\n${failures.length} view(s) failed`);
		process.exit(1);
	}
	log('\nall views aligned');
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exit(1);
});
