import { apiFetch } from '$lib/stores';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, depends }) => {
	const orgSlug = params.orgSlug;
	depends(`org:${orgSlug}:overview`);

	const projects = (async () => {
		const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}`);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Organization not found');
			if (res.status === 403) throw error(403, 'Not a member of this organization');
			throw error(res.status, `Projects load failed: ${res.status}`);
		}
		const payload = await res.json();
		return {
			organizationId: payload.organization.id as string,
			projects: payload.projects as any[]
		};
	})();

	return { orgSlug, projectsPromise: projects };
};
