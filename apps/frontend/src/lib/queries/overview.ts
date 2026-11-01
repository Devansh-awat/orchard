import { apiFetch } from '$lib/stores';

export function overviewQueryOptions(orgSlug: string) {
	return {
		queryKey: ['overview', orgSlug],
		queryFn: async ({ signal }: { signal?: AbortSignal }) => {
			const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}`, { signal });
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

export function userOverviewQueryOptions() {
	return {
		queryKey: ['overview', '__all'],
		queryFn: async () => {
			const res = await apiFetch('/apiv1/overview');
			if (!res.ok) {
				throw Object.assign(new Error(`overview ${res.status}`), { status: res.status });
			}
			return res.json();
		}
	};
}

export function buildsQueryOptions(orgSlug: string) {
	return {
		queryKey: ['builds', orgSlug],
		queryFn: async ({ signal }: { signal?: AbortSignal }) => {
			const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}/builds?scope=all`, { signal });
			if (!res.ok) {
				throw Object.assign(new Error(`builds ${res.status}`), { status: res.status });
			}
			return res.json();
		}
	};
}
