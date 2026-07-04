import { error } from '@sveltejs/kit';
import { apiFetch } from '$lib/stores';
import type { PageLoad } from './$types';

export const ssr = false;

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
		const orgData = await orgRes.json();
		const orgId: string = orgData.id;

		const meRes = await apiFetch(`/apiv1/organizations/${orgId}/members/me`);
		if (!meRes.ok) throw error(meRes.status, 'Failed to load membership');
		const me = await meRes.json();
		const role: 'owner' | 'admin' | 'member' | 'guest' = me.role;
		const isAdmin = role === 'owner' || role === 'admin';

		const myUsageReq = apiFetch(`/apiv1/organizations/${orgId}/quota/me`).then((r) => {
			if (!r.ok) throw new Error('Failed to load personal usage');
			return r.json();
		});
		const orgQuotaReq = apiFetch(`/apiv1/organizations/${orgId}/quota`).then(async (r) => {
			if (!r.ok) return null;
			return r.json();
		});

		const adminTasks = isAdmin
			? Promise.all([
					apiFetch(`/apiv1/organizations/${orgId}/quota/projects`).then((r) =>
						r.ok ? r.json() : null
					),
					apiFetch(`/apiv1/organizations/${orgId}/quota/members`).then((r) =>
						r.ok ? r.json() : null
					),
					apiFetch(
						`/apiv1/organizations/${orgId}/metrics/provisioning?range=${encodeURIComponent(range)}`
					).then((r) => (r.ok ? r.json() : null))
				]).then(([p, m, prov]) => ({
					projectsData: p,
					membersData: m,
					provisioning: prov
				}))
			: Promise.resolve({ projectsData: null, membersData: null, provisioning: null });

		const [myUsage, orgQuota, admin] = await Promise.all([myUsageReq, orgQuotaReq, adminTasks]);

		return {
			orgId,
			role,
			isAdmin,
			myUsage,
			orgQuota,
			projectsData: admin.projectsData,
			membersData: admin.membersData,
			provisioning: admin.provisioning
		};
	})();

	return { orgSlug, range, usagePromise: usage };
};
