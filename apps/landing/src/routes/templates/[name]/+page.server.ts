import { error } from '@sveltejs/kit';
import { registryBase, templatePage } from '$lib/server/registry';
import { renderMarkdown } from '$lib/server/markdown';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, params, setHeaders }) => {
	const page = await templatePage(fetch, params.name);
	if (!page) error(404, 'No template by that name');
	setHeaders({ 'cache-control': 'public, max-age=120' });
	return {
		registry: registryBase(),
		index: page.index,
		latest: page.latest,
		template: page.template,
		yaml: page.yaml,
		readme: page.readme ? renderMarkdown(page.readme) : null
	};
};
