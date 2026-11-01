import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

function uiVersion(): string {
	try {
		return readFileSync(new URL('../../releases/ui/version.txt', import.meta.url), 'utf-8').trim();
	} catch {
		return '';
	}
}

const mock = process.env.ORCHARD_MOCK === '1' ? [(await import('./mock/plugin.ts')).mockApi()] : [];

export default defineConfig({
	plugins: [...mock, tailwindcss(), sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__UI_VERSION__: JSON.stringify(uiVersion()),
		__ORCHARD_MOCK__: JSON.stringify(mock.length > 0)
	},
	server: {
		port: 3000,
		host: '0.0.0.0',
		allowedHosts: ['localhost']
	}
});
