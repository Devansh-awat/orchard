import { redirect } from '@sveltejs/kit';
import { browser, dev } from '$app/environment';
import { goto } from '$app/navigation';
import { sandboxEnvOverride } from '$lib/flags';
import { sandboxesQueryOptions } from '$lib/queries/sandboxes';
import { queryClient } from '$lib/query';
import { instanceFeatures } from '$lib/stores';
import { loadSelectedFromStorage } from '$lib/stores/organizations';

export const ssr = false;

export function load() {
	const override = sandboxEnvOverride();
	if (override === false) redirect(302, '/');
	if (!browser) return {};
	const organizationId = loadSelectedFromStorage();
	if (organizationId) void queryClient.prefetchQuery(sandboxesQueryOptions(organizationId));
	if (override === true || dev) return {};
	void instanceFeatures.load(true).then(
		(features) => {
			if (features.sandboxes || !location.pathname.startsWith('/sandboxes')) return;
			void goto('/', { replaceState: true });
		},
		() => null
	);
	return {};
}
