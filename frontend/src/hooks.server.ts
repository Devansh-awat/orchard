import type { Handle, HandleServerError } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';

const BASE_DOMAIN = env.PUBLIC_BASE_DOMAIN || '';

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

// Forward SSR errors to PostHog Error Tracking. SvelteKit's server context
// can't use the browser SDK, so we POST directly to the capture endpoint.
// Best-effort: never let analytics noise mask the real error.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const key = env.PUBLIC_POSTHOG_KEY;
	if (!key) return;
	const host = env.PUBLIC_POSTHOG_HOST || 'https://at.leafd.dev';
	const err = error instanceof Error ? error : new Error(String(error));
	const payload = {
		api_key: key,
		event: '$exception',
		distinct_id: event.locals.subdomain || event.url.hostname,
		properties: {
			$exception_source: 'sveltekit.server',
			$exception_list: [
				{
					type: err.name,
					value: err.message,
					stacktrace: { type: 'raw', frames: [{ raw: err.stack ?? '' }] },
				},
			],
			route_id: event.route.id,
			url: event.url.pathname,
			status,
			sveltekit_message: message,
		},
	};
	fetch(`${host}/i/v0/e/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	}).catch(() => {});
};
