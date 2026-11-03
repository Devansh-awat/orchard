import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { PageServerLoad } from './$types';
import type { OrgLoginContext } from '$lib/components/login';

/**
 * The org login page is server-rendered so branding paints on the first frame
 * rather than flashing the platform default first.
 *
 * An org with no SSO and an org that does not exist are treated identically
 * (both fall back to the platform login page), so this page never confirms
 * which organizations exist.
 */
export const load: PageServerLoad = async ({ params, fetch }) => {
	const apiBase = env.PUBLIC_API_BASE || '';

	let context: OrgLoginContext | null = null;
	try {
		const res = await fetch(`${apiBase}/apiv1/sso/org/${encodeURIComponent(params.orgSlug)}`);
		if (res.ok) context = (await res.json()) as OrgLoginContext;
	} catch {
		context = null;
	}

	if (!context) {
		redirect(307, '/');
	}

	return { context };
};
