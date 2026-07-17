import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';

export function load() {
	if (env.PUBLIC_GROVE_ENABLED !== 'true') redirect(302, '/');
}
