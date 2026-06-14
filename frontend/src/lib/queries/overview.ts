import { apiFetch } from '$lib/stores';

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
