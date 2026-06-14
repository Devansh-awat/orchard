import { apiFetch } from '$lib/stores';

/**
 * Shared query definition for an org's overview payload (deployments,
 * databases, builds, project metadata). Used both by the page's `createQuery`
 * and by the layout's `prefetchQuery`, so the key + fetcher can never drift
 * out of sync — a mismatch would silently double-fetch instead of warming
 * the cache.
 */
export function overviewQueryOptions(orgSlug: string) {
	return {
		queryKey: ['overview', orgSlug],
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}`);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				let message = body;
				try {
					message = JSON.parse(body)?.message ?? body;
				} catch {}
				throw Object.assign(new Error(message || `overview ${res.status}`), {
					status: res.status
				});
			}
			return res.json();
		}
	};
}
