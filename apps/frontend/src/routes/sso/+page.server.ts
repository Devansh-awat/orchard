import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { PageServerLoad } from './$types';

/**
 * Compatibility entry point for per-org subdomains that rewrite / to this
 * route. SSO lives at /<org-slug> on the main domain, so anything arriving here
 * is forwarded to the org's real login page.
 *
 * An org with no SSO and an org that does not exist both land on the platform
 * login page, as the org login page does, so this never confirms which
 * organizations exist.
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

	redirect(307, '/');
};
