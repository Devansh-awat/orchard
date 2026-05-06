import { apiFetch } from '$lib/stores';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, depends }) => {
	const { orgSlug, projectSlug } = params;
	depends(`project:${orgSlug}/${projectSlug}`);

	const project = (async () => {
		const res = await apiFetch(`/apiv1/projects/by-slugs/${orgSlug}/${projectSlug}`);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Project not found');
			if (res.status === 403) throw error(403, 'Access denied');
			throw error(res.status, `Project load failed: ${res.status}`);
		}
		return res.json();
	})();

	return { orgSlug, projectSlug, projectPromise: project };
};
