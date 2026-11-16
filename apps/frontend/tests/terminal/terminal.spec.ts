import { expect, test, type Page } from '@playwright/test';

const ptyPort = Number(process.env.FAKE_PTY_PORT ?? 7681);

declare global {
	interface Window {
		__orchardTerminal?: {
			cols: number;
			rows: number;
			alternate(): boolean;
			lines(): string[];
			focus(): void;
		};
		__orchardPredictor?: { state: string; metrics: { pending: number } };
	}
}

async function screenLines(page: Page): Promise<string[]> {
	return page.evaluate(() => (window.__orchardTerminal?.lines() ?? []).filter(Boolean));
}

async function waitForPrompt(page: Page, text = 'fake pty ready') {
	await expect.poll(() => screenLines(page), { timeout: 15_000 }).toContain(text);
}

async function typeCommand(page: Page, command: string) {
	await page.locator('.wterm textarea').pressSequentially(command);
	await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => {
	await page.goto(
		`/dev/terminal-harness?endpoint=${encodeURIComponent(`ws://localhost:${ptyPort}/pty`)}`
	);
	await page.waitForFunction(() => Boolean(window.__orchardTerminal));
	await waitForPrompt(page);
	await page.evaluate(() => window.__orchardTerminal?.focus());
});

test('typed input reaches the pty and its echo lands in the buffer', async ({ page }) => {
	await typeCommand(page, 'echo hello');
	await expect.poll(() => screenLines(page)).toContain('you typed: echo hello');
});

test('a width change settles into exactly one resize frame', async ({ page }) => {
	await typeCommand(page, 'resizes');
	await expect
		.poll(() => screenLines(page))
		.toContainEqual(expect.stringMatching(/^\d+ resize frames$/));
	const before = Number(
		(await screenLines(page))
			.filter((l) => l.endsWith(' resize frames'))
			.at(-1)
			?.split(' ')[0]
	);
	const colsBefore = await page.evaluate(() => window.__orchardTerminal?.cols ?? 0);
	await page.locator('input[type=number]').first().fill('1300');
	await expect
		.poll(() => page.evaluate(() => window.__orchardTerminal?.cols ?? 0))
		.toBeGreaterThan(colsBefore);
	await page.waitForTimeout(600);
	await typeCommand(page, 'resizes');
	await expect
		.poll(async () =>
			Number(
				(await screenLines(page))
					.filter((l) => l.endsWith(' resize frames'))
					.at(-1)
					?.split(' ')[0]
			)
		)
		.toBe(before + 1);
});

test('a dropped socket resumes with the exact previous screen', async ({ page }) => {
	await typeCommand(page, 'echo one');
	await typeCommand(page, 'echo two');
	await expect.poll(() => screenLines(page)).toContain('you typed: echo two');
	const before = await screenLines(page);
	await typeCommand(page, 'drop');
	await expect(page.locator('.pod-terminal-note')).toHaveText(/reconnected, session resumed/, {
		timeout: 20_000
	});
	const after = await screenLines(page);
	const history = before.slice(0, -1);
	expect(after.slice(0, history.length)).toEqual(history);
	expect(after[history.length]).toMatch(/^\$ drop/);
	await typeCommand(page, 'echo three');
	await expect.poll(() => screenLines(page)).toContain('you typed: echo three');
});

test('the clear chord asks the shell to redraw instead of wiping locally', async ({
	page,
	browserName
}) => {
	test.fixme(
		browserName !== 'webkit',
		'the old screen stays after the clear chord in Chromium and Firefox'
	);
	await typeCommand(page, 'echo keep');
	await expect.poll(() => screenLines(page)).toContain('you typed: echo keep');
	await page.keyboard.press('Meta+KeyK');
	await expect.poll(() => screenLines(page)).not.toContain('you typed: echo keep');
	await expect.poll(() => screenLines(page)).toContainEqual(expect.stringMatching(/^\$/));
});

test('the alternate screen blocks predictions and comes back intact', async ({ page }) => {
	await typeCommand(page, 'alt');
	await expect.poll(() => page.evaluate(() => window.__orchardTerminal?.alternate())).toBe(true);
	await page.keyboard.press('x');
	const pending = await page.evaluate(() => window.__orchardPredictor?.metrics.pending ?? -1);
	expect(pending).toBe(0);
	await expect(page.locator('.term-predict-overlay')).toHaveCount(0);
});

test('a modifier click on a printed url opens it in a new tab', async ({ page, context }) => {
	await page.evaluate(() => {
		const w = window as unknown as { __orchardTerminalHandle: { write(data: string): void } };
		w.__orchardTerminalHandle.write('\r\nhttp://localhost:5173/app ready\r\n$ ');
	});
	const row = page.locator('.term-row', { hasText: 'http://localhost:5173/app ready' });
	await expect(row).toHaveCount(1);
	await context.route('http://localhost:5173/**', (route) => route.fulfill({ body: 'ok' }));
	const opened = context.waitForEvent('page');
	await row.click({ position: { x: 40, y: 5 }, modifiers: ['ControlOrMeta'] });
	expect((await opened).url()).toBe('http://localhost:5173/app');
});
