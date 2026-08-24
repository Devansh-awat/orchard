import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { PageServerLoad } from './$types';

/**
 * Compatibility entry point. SSO used to live on a per-org subdomain that
 * rewrote / to this route; it now lives at /<org-slug> on the main domain.
 * Anything still arriving here is forwarded to the org's real login page.
 */
export const load: PageServerLoad = async ({ locals, url, fetch }) => {
	const apiBase = env.PUBLIC_API_BASE || '';
	const slug = url.searchParams.get('org') || locals.subdomain;

	if (slug) {
		const res = await fetch(`${apiBase}/apiv1/sso/subdomain/${encodeURIComponent(slug)}`).catch(
			() => null
		);
		if (res?.ok) {
			const org = (await res.json()) as { slug: string };
			redirect(307, `/${org.slug}/login`);
		}
	}

	error(404, 'Unknown single sign-on address.');
};
