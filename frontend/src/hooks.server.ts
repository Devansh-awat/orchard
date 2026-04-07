import type { Handle } from '@sveltejs/kit';

const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN || '';

export const handle: Handle = async ({ event, resolve }) => {
	if (BASE_DOMAIN) {
		const host = event.request.headers.get('host') || '';

		if (
			host.endsWith(`.${BASE_DOMAIN}`) &&
			host !== BASE_DOMAIN &&
			!host.startsWith('www.')
		) {
			const subdomain = host.replace(`.${BASE_DOMAIN}`, '');
			event.locals.subdomain = subdomain;

			// Rewrite root path to /sso for subdomain requests
			if (event.url.pathname === '/') {
				event.url.pathname = '/sso';
				return resolve(event, { transformPageChunk: undefined });
			}
		}
	}

	return resolve(event);
};
