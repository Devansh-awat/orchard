import type { PageLoad } from './$types';

export const ssr = false;

// Data fetching lives in the page's TanStack Query (latest-wins, dedupes
// bursts of SSE-triggered refetches). The load function only passes params.
export const load: PageLoad = ({ params }) => {
	const { orgSlug, projectSlug } = params;
	return { orgSlug, projectSlug };
};
