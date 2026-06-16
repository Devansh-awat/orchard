import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/public';

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
	const subdomain = locals.subdomain;

	if (!subdomain) {
		return { subdomain: null, branding: null };
	}

	try {
		const apiBase = env.PUBLIC_API_BASE || '';
		const res = await fetch(`${apiBase}/apiv1/sso/subdomain/${subdomain}`);

		if (!res.ok) {
			return { subdomain, branding: null };
		}

		const branding = await res.json();
		return { subdomain, branding };
	} catch {
		return { subdomain, branding: null };
	}
};
