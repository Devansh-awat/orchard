import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const mock = process.env.ORCHARD_MOCK === '1' ? [(await import('./mock/plugin.ts')).mockApi()] : [];

export default defineConfig({
	plugins: [...mock, tailwindcss(), sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__ORCHARD_MOCK__: JSON.stringify(mock.length > 0)
	},
	server: {
		port: 3000,
		host: '0.0.0.0',
		allowedHosts: ['localhost']
	}
});
