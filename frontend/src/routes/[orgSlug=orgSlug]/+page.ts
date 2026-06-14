import type { PageLoad } from './$types';
import { queryClient } from '$lib/query';
import { overviewQueryOptions } from '$lib/queries/overview';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	void queryClient.prefetchQuery(overviewQueryOptions(params.orgSlug));
	return { orgSlug: params.orgSlug };
};
