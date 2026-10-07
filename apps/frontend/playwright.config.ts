import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.HARNESS_PORT ?? 3000);
const ptyPort = Number(process.env.FAKE_PTY_PORT ?? 7681);
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL;

export default defineConfig({
	testDir: './tests/terminal',
	testMatch: /.*\.spec\.ts/,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	use: {
		baseURL: `http://localhost:${port}`,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				...(chromiumChannel ? { channel: chromiumChannel } : {})
			}
		},
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }
	],
	webServer: [
		{
			command: `FAKE_PTY_PORT=${ptyPort} FAKE_PTY_DELAY_MS=120 node tests/terminal/fake-pty.mjs`,
			port: ptyPort,
			reuseExistingServer: !process.env.CI,
			timeout: 30_000
		},
		{
			command: `pnpm dev --port ${port} --strictPort`,
			url: `http://localhost:${port}/dev/terminal-harness`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	]
});
