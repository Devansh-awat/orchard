import { error } from '@sveltejs/kit';
import { get, writable } from 'svelte/store';
import { apiFetch, organizations } from '$lib/stores';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, depends, url }) => {
	const orgSlug = params.orgSlug;
	const range = url.searchParams.get('range') ?? '24h';
	depends(`org:${orgSlug}:usage`);
	depends(`org:${orgSlug}:usage:metrics:${range}`);

	const progress = writable({ done: 0, total: 7 });
	const step = <T>(work: Promise<T>) =>
		work.finally(() => progress.update((p) => ({ ...p, done: p.done + 1 })));
	const json = (path: string) => step(apiFetch(path).then((r) => (r.ok ? r.json() : null)));

	const known = get(organizations).find((o) => o.slug === orgSlug);

	const resolveOrgId = async (): Promise<string> => {
		if (known?.id) return known.id;
		const orgRes = await step(apiFetch(`/apiv1/organizations/slug/${orgSlug}`));
		if (!orgRes.ok) {
			if (orgRes.status === 404) throw error(404, 'Organization not found');
			throw error(orgRes.status, "Couldn't load organization");
		}
		return (await orgRes.json()).id;
	};

	const adminReads = (orgId: string) =>
		Promise.all([
			json(`/apiv1/organizations/${orgId}/quota`),
			json(`/apiv1/organizations/${orgId}/quota/projects`),
			json(`/apiv1/organizations/${orgId}/quota/members`),
			json(`/apiv1/organizations/${orgId}/metrics/provisioning?range=${encodeURIComponent(range)}`)
		]);

	const usage = (async () => {
		const orgId = await resolveOrgId();
		if (known?.id) progress.update((p) => ({ ...p, done: p.done + 1 }));

		const likelyAdmin = known?.myRole === 'owner' || known?.myRole === 'admin';
		const early = likelyAdmin ? adminReads(orgId) : null;

		const [me, myUsage] = await Promise.all([
			step(
				apiFetch(`/apiv1/organizations/${orgId}/members/me`).then((r) => {
					if (!r.ok) throw error(r.status, "Couldn't load membership");
					return r.json();
				})
			),
			step(
				apiFetch(`/apiv1/organizations/${orgId}/quota/me`).then((r) => {
					if (!r.ok) throw new Error("Couldn't load personal usage");
					return r.json();
				})
			)
		]);

		const role: 'owner' | 'admin' | 'member' | 'guest' = me.role;
		const isAdmin = role === 'owner' || role === 'admin';

		if (!isAdmin) {
			early?.catch(() => null);
			progress.set({ done: 3, total: 3 });
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

		const [orgQuota, projectsData, membersData, provisioning] = await (early ?? adminReads(orgId));

		return { orgId, role, isAdmin, myUsage, orgQuota, projectsData, membersData, provisioning };
	})();

	return { orgSlug, range, usagePromise: usage, usageProgress: progress };
};
