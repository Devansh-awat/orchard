import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) error(404, 'Not found');
	const view = url.searchParams.get('view');
	const theme = url.searchParams.get('theme');
	return {
		view: view === 'diff' ? ('diff' as const) : ('editor' as const),
		theme: theme === 'dark' || theme === 'light' ? theme : null,
		file: url.searchParams.get('file')
	};
};
