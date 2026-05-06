import { apiFetch } from '$lib/stores';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ params, url, depends }) => {
	const podName = params.name;
	const namespace = url.searchParams.get('namespace') || 'default';
	depends(`pod:${namespace}/${podName}`);

	const pod = (async () => {
		const res = await apiFetch(`/apiv1/pods/${podName}?namespace=${namespace}`);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Pod not found');
			throw error(res.status, 'Failed to fetch pod details');
		}
		return res.json();
	})();

	return { podName, namespace, podPromise: pod };
};
