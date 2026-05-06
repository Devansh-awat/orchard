import { apiFetch } from '$lib/stores';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, depends }) => {
	const orgSlug = params.orgSlug;
	depends(`org:${orgSlug}:usage`);

	const usage = (async () => {
		const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
		if (!orgRes.ok) {
			if (orgRes.status === 404) throw error(404, 'Organization not found');
			throw error(orgRes.status, 'Failed to load organization');
		}
		const orgData = await orgRes.json();
		const orgId: string = orgData.id;

		const [qRes, pRes] = await Promise.all([
			apiFetch(`/apiv1/organizations/${orgId}/quota`),
			apiFetch(`/apiv1/organizations/${orgId}/quota/projects`),
		]);
		if (!qRes.ok) throw error(qRes.status, 'Failed to load usage');
		if (!pRes.ok) throw error(pRes.status, 'Failed to load project usage');
		const orgQuota = await qRes.json();
		const pdata = await pRes.json();
		return { orgId, orgQuota, projects: pdata.projects as any[] };
	})();

	return { orgSlug, usagePromise: usage };
};
