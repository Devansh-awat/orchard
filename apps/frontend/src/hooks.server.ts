import type { Handle, HandleServerError } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import sansFont from '$lib/assets/fonts/Plus_Jakarta_Sans/PlusJakartaSans-VariableFont_wght.woff2';
import { loadGraftRegistry } from '$lib/server/grafts';
import { setGraftRegistry } from '$lib/grafts/registry';

const BASE_DOMAIN = env.PUBLIC_BASE_DOMAIN || '';

export const handle: Handle = async ({ event, resolve }) => {
	// Merge consecutive slashes (`//ysws//projects` → `/ysws/projects`).
	// Doubled slashes still render a page but break every exact-match on
	// pathname (sidebar active state, breadcrumbs), and relative links keep
	// compounding the bad prefix. Normalize once at the entry point.
	const { pathname } = event.url;
	if (pathname.includes('//')) {
		const normalized = pathname.replace(/\/{2,}/g, '/');
		return new Response(null, {
			status: 308,
			headers: { Location: normalized + event.url.search }
		});
	}

	if (BASE_DOMAIN) {
		const host = event.request.headers.get('host') || '';

		if (host.endsWith(`.${BASE_DOMAIN}`) && host !== BASE_DOMAIN && !host.startsWith('www.')) {
			const subdomain = host.replace(`.${BASE_DOMAIN}`, '');
			event.locals.subdomain = subdomain;

			// An org's subdomain is a vanity address now, not a place the app
			// runs: login lives at /<org-slug> on the main domain. The apex
			// serves everything, so nothing here needs a per-subdomain
			// allowlist any more — the whole host forwards.
			if (!pathname.startsWith('/apiv1/') && !event.route.id?.startsWith('/status')) {
				const target =
					pathname === '/'
						? `https://${BASE_DOMAIN}/sso?org=${encodeURIComponent(subdomain)}`
						: `https://${BASE_DOMAIN}${pathname}${event.url.search}`;
				return new Response(null, { status: 302, headers: { Location: target } });
			}
		}
	}

	const grafts = loadGraftRegistry();
	setGraftRegistry(grafts);
	const graftScript = `<script>window.__ORCHARD_GRAFTS__=${JSON.stringify(grafts).replace(/</g, '\\u003c')}</script>`;
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%orchard.font.sans%', sansFont).replace('%orchard.grafts%', graftScript)
	});
};

// Forward SSR errors to PostHog Error Tracking. SvelteKit's server context
// can't use the browser SDK, so we POST directly to the capture endpoint.
// Best-effort: never let analytics noise mask the real error.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const key = env.PUBLIC_POSTHOG_KEY;
	if (!key) return;
	const host = env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
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
					stacktrace: { type: 'raw', frames: [{ raw: err.stack ?? '' }] }
				}
			],
			route_id: event.route.id,
			url: event.url.pathname,
			status,
			sveltekit_message: message
		}
	};
	fetch(`${host}/i/v0/e/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	}).catch(() => {});
};
