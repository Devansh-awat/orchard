import { apiFetch } from '$lib/stores';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Keep client-only — auth is cookie-based and apiBase is set in the browser.
export const ssr = false;

export interface OverviewBuilds {
	active: any[];
	recent: any[];
}

export interface OverviewPayload {
	organization: { id: string; slug: string; name: string };
	projects: any[];
	deployments: any[];
	databases: any[];
	builds: OverviewBuilds;
}

export const load: PageLoad = ({ params, depends }) => {
	const orgSlug = params.orgSlug;
	depends(`org:${orgSlug}:overview`);

	const overview = (async () => {
		const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}`);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Organization not found');
			if (res.status === 403) throw error(403, 'Not a member of this organization');
			throw error(res.status, `Overview failed: ${res.status}`);
		}
		return (await res.json()) as OverviewPayload;
	})();

	return {
		orgSlug,
		// Streamed promise — page shell renders instantly while this resolves.
		overview,
	};
};
