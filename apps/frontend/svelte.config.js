import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(),
		version: {
			// Poll only in real builds: in dev a restarted vite changes the
			// build version under an open tab, which would flip `updated`
			// permanently and turn the layout's stale-build reload guard
			// into a reload loop.
			pollInterval: process.env.NODE_ENV === 'production' ? 60000 : 0
		},
		alias: {
			$routes: 'src/routes',
			$health: '../../packages/health/src/health.ts'
		}
	}
};

export default config;
