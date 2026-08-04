import { redirect } from '@sveltejs/kit';
import { sandboxEnabled } from '$lib/flags';

export function load() {
	if (!sandboxEnabled()) redirect(302, '/');
}
