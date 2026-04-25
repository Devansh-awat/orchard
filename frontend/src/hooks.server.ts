import type { Handle } from '@sveltejs/kit';

const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN || '';

// Routes that are allowed on SSO subdomains
const SSO_ALLOWED_PATHS = ['/sso', '/oauth/callback', '/apiv1/'];

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

			const pathname = event.url.pathname;

			// Rewrite root path to /sso for subdomain requests
			if (pathname === '/') {
				event.url.pathname = '/sso';
				return resolve(event, { transformPageChunk: undefined });
			}

			// Block all routes except SSO-related paths on subdomains
			const isAllowed = SSO_ALLOWED_PATHS.some((p) => pathname.startsWith(p));
			if (!isAllowed) {
				// Redirect non-SSO paths back to the main domain
				const mainUrl = `https://${BASE_DOMAIN}${pathname}${event.url.search}`;
				return new Response(null, {
					status: 302,
					headers: { Location: mainUrl },
				});
			}
		}
	}

	return resolve(event);
};
