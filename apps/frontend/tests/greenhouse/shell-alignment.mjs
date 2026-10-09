import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.HARNESS_URL ?? `http://localhost:${process.env.HARNESS_PORT ?? 3000}`;
const pty = process.env.PTY_URL ?? `ws://localhost:${process.env.FAKE_PTY_PORT ?? 7681}/pty`;
const channel = process.env.PW_CHROMIUM_CHANNEL;
const SESSION = '11111111-1111-4111-8111-111111111111';
const FONT_SIZES = [11, 12, 13, 14, 15];
const DISPLAY_SIZES = [24];
const TOLERANCE = 1;
const log = (line) => process.stdout.write(`${line}\n`);
const shots = process.env.SHELL_SHOT_DIR ? resolve(process.env.SHELL_SHOT_DIR) : null;
if (shots) mkdirSync(shots, { recursive: true });

const harness = (query) =>
	`${base}/dev/greenhouse-harness?pty=${encodeURIComponent(pty)}${query ? `&${query}` : ''}`;

const scenarios = [
	{ name: 'home', url: harness('machine=sbx-leaf') },
	{ name: 'changes', url: harness(`machine=sbx-leaf&session=${SESSION}`) },
	{
		name: 'files',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.getByRole('tab', { name: 'All files' }).click();
			await page.waitForSelector('[data-align="tree-row"]', { timeout: 10_000 });
		}
	},
	{
		name: 'diff',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.locator('[data-align="change-row"]').first().click();
			await page.waitForSelector('[data-align="statusbar"]', { timeout: 10_000 });
		}
	},
	{
		name: 'editor',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.getByRole('tab', { name: 'All files' }).click();
			await page.locator('[data-align="tree-row"]', { hasText: 'package.json' }).click();
			await page.waitForSelector('[data-align="statusbar"]', { timeout: 10_000 });
			await page.waitForTimeout(400);
		}
	},
	{
		name: 'checks',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.getByRole('tab', { name: 'Checks' }).click();
			await page.waitForTimeout(400);
		}
	},
	{
		name: 'dock-watch',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.getByRole('button', { name: 'New terminal' }).click();
			await page.getByRole('button', { name: 'Watch someone’s terminal' }).click();
			await page.getByRole('menuitem', { name: 'Alex Rivera' }).click();
			await page.waitForTimeout(400);
		}
	},
	{
		name: 'admin-lifecycle',
		shot: true,
		url: harness('machine=sbx-leaf&role=admin'),
		async prepare(page) {
			await page.waitForSelector('.ui-empty-title', { timeout: 10_000 });
		},
		async check(page) {
			return page.evaluate(() => {
				const failures = [];
				const forbidden = window.__ghForbidden ?? [];
				for (const call of forbidden) failures.push(`admin view asked for ${call}`);
				const title = document.querySelector('.ui-empty-title')?.textContent?.trim();
				if (title !== 'Only the host and people they invite can open this machine')
					failures.push(`admin empty state title: ${title ?? 'missing'}`);
				const labels = [...document.querySelectorAll('.ui-empty-action button')].map((b) =>
					(b.textContent ?? '').trim()
				);
				for (const want of ['Stop', 'Delete…'])
					if (!labels.includes(want)) failures.push(`admin action missing: ${want}`);
				if (document.querySelector('.gh .chat, .col--right'))
					failures.push('admin can see inside the machine');
				return failures;
			});
		}
	},
	{
		name: 'guest-chat',
		shot: true,
		url: harness(`machine=sbx-leaf&session=${SESSION}&role=collaborator`),
		async prepare(page) {
			const notice = page.getByRole('button', { name: 'Continue' });
			if (await notice.isVisible().catch(() => false)) await notice.click();
			await page.waitForSelector('.gh .chat textarea', { timeout: 10_000 });
			await page.waitForTimeout(300);
		},
		async check(page) {
			return page.evaluate(() => {
				const failures = [];
				const pane = document.querySelector('.gh .chat');
				const text = pane?.textContent ?? '';
				if (/unreachable/i.test(text)) failures.push('guest chat says the agent is unreachable');
				const box = pane?.querySelector('textarea');
				if (!box) failures.push('guest has no composer');
				else if (box.disabled) failures.push('guest composer is disabled');
				return failures;
			});
		}
	},
	{
		name: 'share-scrolled',
		shot: true,
		url: harness('machine=sbx-leaf'),
		async prepare(page) {
			await page.locator('.switch').click();
			await page.getByRole('menuitem', { name: 'Share' }).click();
			await page.waitForSelector('.ui-modal .disclosure', { timeout: 10_000 });
			await page.evaluate(() => {
				const body = document.querySelector('.ui-modal-body');
				if (body) body.scrollTop = 160;
			});
			await page.waitForTimeout(300);
		},
		async check(page) {
			return page.evaluate(() => {
				const failures = [];
				const dialog = document.querySelector('.ui-modal');
				const header = dialog?.querySelector('.ui-modal-header');
				const body = dialog?.querySelector('.ui-modal-body');
				if (!dialog || !header || !body) return ['share sheet did not open'];
				if (body.scrollTop === 0) failures.push('share sheet does not scroll at this size');
				if (parseFloat(getComputedStyle(header).borderBottomWidth) < 1)
					failures.push('scrolled sheet header has no hairline');
				if (getComputedStyle(header).borderBottomColor === 'rgba(0, 0, 0, 0)')
					failures.push('scrolled sheet hairline is transparent');
				if (body.getBoundingClientRect().top < header.getBoundingClientRect().bottom - 0.5)
					failures.push('sheet content starts above the header hairline');
				const points = [...dialog.querySelectorAll('.d-points li')].map(
					(li) => li.textContent ?? ''
				);
				if (!points.some((t) => t.includes('Admins of this organization')))
					failures.push('disclosure does not mention org admins');
				if (!points.some((t) => t.includes('Orchard tools')))
					failures.push('disclosure does not mention the agent Orchard tools');
				if (!points.some((t) => t.includes('Removing a guest')))
					failures.push('disclosure does not say removal is not a reset');
				return failures;
			});
		}
	},
	{
		name: 'sidebar-hidden',
		url: harness(`machine=sbx-leaf&session=${SESSION}`),
		async prepare(page) {
			await page.getByRole('button', { name: 'Hide sidebar' }).click();
			await page.waitForTimeout(200);
		}
	}
];

function audit({ fontSizes, displaySizes, tolerance }) {
	const failures = [];
	const counts = {};
	const near = (a, b) => Math.abs(a - b) <= tolerance;
	const shell = document.querySelector('.gh.shell');
	if (!shell) return { failures: ['no .gh.shell on the page'], counts };

	const visible = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
	};
	const skipped = (el) =>
		!!el.closest('[data-align-skip], .monaco-editor, .wterm, .ui-modal, [popover]');
	const all = (sel) => [...shell.querySelectorAll(sel)].filter((el) => visible(el));
	const describe = (el) => {
		const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
		const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
		return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}>${text ? ` "${text}"` : ''}`;
	};
	const baseline = (el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) =>
				n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
		});
		const text = walker.nextNode();
		if (!text) return el.getBoundingClientRect().bottom;
		const wrap = document.createElement('span');
		const probe = document.createElement('span');
		probe.style.cssText =
			'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0';
		text.parentNode.insertBefore(wrap, text);
		wrap.appendChild(text);
		wrap.appendChild(probe);
		const y = probe.getBoundingClientRect().top;
		wrap.parentNode.insertBefore(text, wrap);
		wrap.remove();
		return y;
	};
	const same = (label, items, measure) => {
		counts[label] = items.length;
		if (items.length < 2) return;
		const values = items.map((el) => ({ el, v: measure(el) }));
		const ref = values[0].v;
		for (const { el, v } of values) {
			if (!near(v, ref))
				failures.push(`${label}: ${describe(el)} is ${v.toFixed(1)}, expected ${ref.toFixed(1)}`);
		}
	};

	const bars = all('[data-align="topbar"]');
	if (bars.length === 0) failures.push('no top bars found');
	same('top bar height', bars, (el) => el.getBoundingClientRect().height);
	same('top bar top', bars, (el) => el.getBoundingClientRect().top);
	same('top bar hairline y', bars, (el) => el.getBoundingClientRect().bottom);
	for (const bar of bars) {
		if (parseFloat(getComputedStyle(bar).borderBottomWidth) < 1)
			failures.push(`top bar without a hairline: ${describe(bar)}`);
	}
	same('top bar title baseline', all('[data-align="title"]'), baseline);

	const strips = [...all('[data-align="tabstrip"]'), ...all('[data-align="center"] .strip')];
	same('tab strip height', strips, (el) => el.getBoundingClientRect().height);
	same(
		'tab strip hairline y',
		strips.filter((el) => !el.closest('[data-align="dock"]')),
		(el) => el.getBoundingClientRect().bottom
	);
	same(
		'tab label baseline',
		[...all('[data-align="tab-label"]'), ...all('[data-align="center"] .strip-title')].filter(
			(el) => !el.closest('[data-align="dock"]')
		),
		baseline
	);

	same(
		'sidebar label x',
		all('[data-align="sidebar-label"]'),
		(el) => el.getBoundingClientRect().left
	);
	same('sidebar icon centre x', all('[data-align="sidebar-icon"]'), (el) => {
		const r = el.getBoundingClientRect();
		return r.left + r.width / 2;
	});
	same(
		'sidebar child label x',
		all('[data-align="sidebar-child-label"]'),
		(el) => el.getBoundingClientRect().left
	);
	const centre = (el) => {
		const r = el.getBoundingClientRect();
		return r.left + r.width / 2;
	};
	same('sidebar child icon centre x', all('[data-align="sidebar-child-icon"]'), centre);
	{
		const parent = all('[data-align="sidebar-icon"]')[0];
		const child = all('[data-align="sidebar-child-icon"]')[0];
		if (parent && child && !near(centre(child) - centre(parent), 16))
			failures.push(
				`sidebar child indent is ${(centre(child) - centre(parent)).toFixed(1)}, expected 16.0`
			);
	}
	same(
		'sidebar trailing edge',
		all('[data-align="sidebar-end"]'),
		(el) => el.getBoundingClientRect().right
	);
	const scrolled = (el) => {
		for (let node = el.parentElement; node && node !== shell; node = node.parentElement) {
			if (node.scrollLeft > 0) return true;
		}
		return false;
	};
	same(
		'right panel leading edge',
		all('[data-align="right-edge"]').filter((el) => !scrolled(el)),
		(el) => el.getBoundingClientRect().left
	);
	same(
		'centre leading edge',
		all('[data-align="center-edge"]'),
		(el) => el.getBoundingClientRect().left
	);
	same(
		'change stat right edge',
		all('[data-align="change-stat"]'),
		(el) => el.getBoundingClientRect().right
	);
	same('status bar baseline', all('[data-align="status-item"]'), baseline);

	for (const el of all('[data-align="stat"], [data-align="change-stat"]')) {
		if (!getComputedStyle(el).fontVariantNumeric.includes('tabular-nums'))
			failures.push(`diffstat without tabular nums: ${describe(el)}`);
	}

	const texts = [...shell.querySelectorAll('*')].filter(
		(el) =>
			!skipped(el) &&
			visible(el) &&
			[...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
	);
	counts['text nodes'] = texts.length;
	for (const el of texts) {
		const style = getComputedStyle(el);
		const size = parseFloat(style.fontSize);
		const display = el.closest('[data-type="display"]');
		const allowed = display ? displaySizes : fontSizes;
		if (!allowed.includes(Math.round(size * 10) / 10))
			failures.push(`font size ${size}px: ${describe(el)}`);
		const lh = parseFloat(style.lineHeight);
		if (!Number.isFinite(lh)) failures.push(`line height "${style.lineHeight}": ${describe(el)}`);
		else if (Math.abs(lh / 4 - Math.round(lh / 4)) > 0.01)
			failures.push(`line height ${lh}px not a multiple of 4: ${describe(el)}`);
		const weight = Number(style.fontWeight);
		if (weight !== 400 && weight !== 600) failures.push(`font weight ${weight}: ${describe(el)}`);
		if (style.fontStyle === 'italic') failures.push(`italic text: ${describe(el)}`);
		if (style.textTransform === 'uppercase') failures.push(`uppercase text: ${describe(el)}`);
	}

	const iconOnly = [...shell.querySelectorAll('button, a[href], [role="button"]')].filter(
		(el) =>
			!skipped(el) &&
			visible(el) &&
			el.querySelector('svg, img, .ui-avatar') &&
			(el.textContent ?? '').trim().length === 0
	);
	counts['icon buttons'] = iconOnly.length;
	for (const el of iconOnly) {
		const r = el.getBoundingClientRect();
		const min = el.matches('.strip-close, [data-inline-close]') ? 24 : 28;
		if (r.width < min - 0.5 || r.height < min - 0.5)
			failures.push(
				`icon button ${r.width.toFixed(0)}x${r.height.toFixed(0)} < ${min}: ${describe(el)} [${el.getAttribute('aria-label') ?? ''}]`
			);
		if (!el.closest('[title]'))
			failures.push(
				`icon button without a tooltip: ${describe(el)} [${el.getAttribute('aria-label') ?? ''}]`
			);
	}
	const spaced = iconOnly.filter(
		(el) =>
			!el.closest('.gh-split') &&
			!el.matches('.strip-close, [data-inline-close]') &&
			!el.closest('[data-align="stack"]')
	);
	for (const a of spaced) {
		for (const b of spaced) {
			if (a === b || a.parentElement !== b.parentElement) continue;
			const ra = a.getBoundingClientRect();
			const rb = b.getBoundingClientRect();
			if (!near(ra.top, rb.top) || rb.left < ra.right) continue;
			const between = spaced.some((c) => {
				const rc = c.getBoundingClientRect();
				return (
					c !== a &&
					c !== b &&
					c.parentElement === a.parentElement &&
					rc.left >= ra.right &&
					rc.right <= rb.left
				);
			});
			if (between) continue;
			const gap = rb.left - ra.right;
			if (gap < 8 - 0.5 && gap < 40)
				failures.push(
					`icon buttons ${gap.toFixed(0)}px apart: ${describe(a)} [${a.getAttribute('aria-label')}] / [${b.getAttribute('aria-label')}]`
				);
		}
	}
	return { failures: [...new Set(failures)], counts };
}

const browser = await chromium.launch(channel ? { channel } : {});
let failed = 0;
try {
	for (const theme of ['light', 'dark']) {
		const context = await browser.newContext({
			viewport: { width: 1512, height: 945 },
			colorScheme: theme
		});
		const page = await context.newPage();
		for (const scenario of scenarios) {
			await page.goto(scenario.url);
			await page.waitForSelector('.gh.shell [data-align="topbar"]', { timeout: 30_000 });
			await page.waitForTimeout(600);
			const scheme = await page.evaluate(() =>
				document.documentElement.classList.contains('dark') ? 'dark' : 'light'
			);
			if (scheme !== theme) throw new Error(`expected the ${theme} theme, the page is ${scheme}`);
			if (scenario.prepare) await scenario.prepare(page);
			const { failures, counts } = await page.evaluate(audit, {
				fontSizes: FONT_SIZES,
				displaySizes: DISPLAY_SIZES,
				tolerance: TOLERANCE
			});
			if (scenario.check) failures.push(...(await scenario.check(page)));
			if (shots && scenario.shot) {
				await page.screenshot({ path: join(shots, `final-${scenario.name}-${theme}.png`) });
			}
			const label = `${theme}/${scenario.name}`;
			const measured = Object.entries(counts)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ');
			if (failures.length === 0) {
				log(`ok   ${label}`);
				if (process.env.VERBOSE) log(`     ${measured}`);
			} else {
				failed += failures.length;
				log(`FAIL ${label} (${failures.length})`);
				for (const f of failures) log(`     ${f}`);
			}
		}
		await context.close();
	}
} finally {
	await browser.close();
}

if (failed > 0) {
	log(`\n${failed} alignment failures`);
	process.exit(1);
}
log('\nshell alignment holds');
