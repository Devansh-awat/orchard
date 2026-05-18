import type { PageLoad } from './$types';

// Keep client-only — auth is cookie-based and apiBase is set in the browser.
export const ssr = false;

export const load: PageLoad = ({ params }) => {
	return { orgSlug: params.orgSlug };
};
