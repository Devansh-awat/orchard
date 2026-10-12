import { graftCatalog, registryBase } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=120' });
	const { grafts, error } = await graftCatalog(fetch);
	return { grafts, error, registry: registryBase() };
};
