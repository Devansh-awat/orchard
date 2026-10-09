import { redirect } from '@sveltejs/kit';
import { browser, dev } from '$app/environment';
import { goto } from '$app/navigation';
import { sandboxEnvOverride } from '$lib/flags';
import { instanceFeatures } from '$lib/stores';

export const ssr = false;

export function load() {
	const override = sandboxEnvOverride();
	if (override === false) redirect(302, '/');
	if (override === true || dev || !browser) return {};
	void instanceFeatures.load(true).then(
		(features) => {
			if (features.sandboxes || !location.pathname.startsWith('/sandboxes')) return;
			void goto('/', { replaceState: true });
		},
		() => null
	);
	return {};
}
