import { error } from '@sveltejs/kit';
import { apiFetch } from '$lib/stores';
import type { PageLoad } from './$types';

export const ssr = false;

const json = (path: string) => apiFetch(path).then((r) => (r.ok ? r.json() : null));

export const load: PageLoad = ({ params, depends, url }) => {
	const orgSlug = params.orgSlug;
	const range = url.searchParams.get('range') ?? '24h';
	depends(`org:${orgSlug}:usage`);
	depends(`org:${orgSlug}:usage:metrics:${range}`);

	const usage = (async () => {
		const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
		if (!orgRes.ok) {
			if (orgRes.status === 404) throw error(404, 'Organization not found');
			throw error(orgRes.status, 'Failed to load organization');
		}
		const orgId: string = (await orgRes.json()).id;

		const [me, myUsage] = await Promise.all([
			apiFetch(`/apiv1/organizations/${orgId}/members/me`).then((r) => {
				if (!r.ok) throw error(r.status, 'Failed to load membership');
				return r.json();
			}),
			apiFetch(`/apiv1/organizations/${orgId}/quota/me`).then((r) => {
				if (!r.ok) throw new Error('Failed to load personal usage');
				return r.json();
			})
		]);

		const role: 'owner' | 'admin' | 'member' | 'guest' = me.role;
		const isAdmin = role === 'owner' || role === 'admin';

		if (!isAdmin) {
			return {
				orgId,
				role,
				isAdmin,
				myUsage,
				orgQuota: null,
				projectsData: null,
				membersData: null,
				provisioning: null
			};
		}

		const [orgQuota, projectsData, membersData, provisioning] = await Promise.all([
			json(`/apiv1/organizations/${orgId}/quota`),
			json(`/apiv1/organizations/${orgId}/quota/projects`),
			json(`/apiv1/organizations/${orgId}/quota/members`),
			json(`/apiv1/organizations/${orgId}/metrics/provisioning?range=${encodeURIComponent(range)}`)
		]);

		return { orgId, role, isAdmin, myUsage, orgQuota, projectsData, membersData, provisioning };
	})();

	return { orgSlug, range, usagePromise: usage };
};
