import { expect, test, type Page } from '@playwright/test';

const ptyPort = Number(process.env.FAKE_PTY_PORT ?? 7681);

declare global {
	interface Window {
		__orchardTerminal?: {
			cols: number;
			rows: number;
			buffer: {
				active: {
					length: number;
					baseY: number;
					cursorX: number;
					cursorY: number;
					type: string;
					getLine(i: number): { translateToString(trim?: boolean): string } | undefined;
				};
			};
			focus(): void;
		};
		__orchardPredictor?: { state: string; metrics: { pending: number } };
	}
}

async function screenLines(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const t = window.__orchardTerminal;
		if (!t) return [];
		const b = t.buffer.active;
		const out: string[] = [];
		for (let i = 0; i < b.length; i++) {
			const line = b.getLine(i)?.translateToString(true) ?? '';
			if (line) out.push(line);
		}
		return out;
	});
}

async function waitForPrompt(page: Page, text = 'fake pty ready') {
	await expect.poll(() => screenLines(page), { timeout: 15_000 }).toContain(text);
}

async function typeCommand(page: Page, command: string) {
	await page.locator('.xterm-helper-textarea').pressSequentially(command);
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
			.filter((l) => / resize frames$/.test(l))
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
					.filter((l) => / resize frames$/.test(l))
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

test('the clear chord asks the shell to redraw instead of wiping locally', async ({ page }) => {
	await typeCommand(page, 'echo keep');
	await expect.poll(() => screenLines(page)).toContain('you typed: echo keep');
	await page.keyboard.press('Meta+KeyK');
	await expect.poll(() => screenLines(page)).not.toContain('you typed: echo keep');
	await expect.poll(() => screenLines(page)).toContainEqual(expect.stringMatching(/^\$/));
});

test('the alternate screen blocks predictions and comes back intact', async ({ page }) => {
	await typeCommand(page, 'alt');
	await expect
		.poll(() => page.evaluate(() => window.__orchardTerminal?.buffer.active.type))
		.toBe('alternate');
	await page.keyboard.press('x');
	const pending = await page.evaluate(() => window.__orchardPredictor?.metrics.pending ?? -1);
	expect(pending).toBe(0);
	await expect(page.locator('.xterm-decoration')).toHaveCount(0);
});
