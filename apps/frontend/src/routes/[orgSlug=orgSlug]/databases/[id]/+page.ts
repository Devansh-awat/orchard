import { error } from '@sveltejs/kit';
import { apiFetch } from '$lib/stores';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, depends }) => {
	const id = params.id;
	depends(`database:${id}`);

	const database = (async () => {
		const res = await apiFetch(`/apiv1/databases/${id}`);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Database not found');
			if (res.status === 403) throw error(403, 'Access denied');
			throw error(res.status, `Database load failed: ${res.status}`);
		}
		return res.json();
	})();

	return { dbId: id, databasePromise: database };
};
