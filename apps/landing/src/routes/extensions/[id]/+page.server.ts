import { error } from '@sveltejs/kit';
import { graftPage, graftTier, registryBase } from '$lib/server/registry';
import { renderMarkdown } from '$lib/server/markdown';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, params, setHeaders }) => {
	const page = await graftPage(fetch, params.id);
	if (!page) error(404, 'No graft by that name');
	setHeaders({ 'cache-control': 'public, max-age=120' });
	return {
		registry: registryBase(),
		index: page.index,
		latest: page.latest,
		manifest: page.manifest,
		tier: graftTier(page.index),
		publisher: page.listing?.publisher ?? page.index.publisher,
		repo: page.listing?.repo ?? page.index.repo ?? null,
		readme: page.readme ? renderMarkdown(page.readme) : null
	};
};
