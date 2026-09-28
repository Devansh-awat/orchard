import { catalog, registryBase } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=120' });
	const { templates, error } = await catalog(fetch);
	return { templates, error, registry: registryBase() };
};
