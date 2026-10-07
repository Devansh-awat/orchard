import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) error(404, 'Not found');
	return {
		endpoint: url.searchParams.get('endpoint') ?? 'ws://localhost:7681/pty'
	};
};
