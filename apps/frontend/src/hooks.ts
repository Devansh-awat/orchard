import type { Reroute } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';

const BASE_DOMAIN = env.PUBLIC_BASE_DOMAIN || '';
const RESOLVE_TTL_MS = 60_000;

const hosts = new Map<string, { slug: string | null; exp: number }>();

// A status page on its own host renders the /status/[slug] route while the
// address bar keeps the host. Which slug a host serves is only known to the
// API, so it is asked once a minute per host; a host that is not a status
// page falls through to the org vanity redirect in hooks.server.ts.
export const reroute: Reroute = async ({ url, fetch }) => {
	if (!BASE_DOMAIN) return;
	const host = url.hostname;
	if (!host.endsWith(`.${BASE_DOMAIN}`) || host === BASE_DOMAIN || host.startsWith('www.')) return;
	if (url.pathname.startsWith('/apiv1/') || url.pathname.startsWith('/status/')) return;
	const hit = hosts.get(host);
	let slug: string | null | undefined = hit && hit.exp > Date.now() ? hit.slug : undefined;
	if (slug === undefined) {
		try {
			const res = await fetch(
				`https://${BASE_DOMAIN}/apiv1/status/resolve?host=${encodeURIComponent(host)}`
			);
			slug = res.ok ? ((await res.json())?.slug ?? null) : null;
		} catch {
			slug = null;
		}
		hosts.set(host, { slug: slug ?? null, exp: Date.now() + RESOLVE_TTL_MS });
	}
	if (slug) return `/status/${slug}`;
};
