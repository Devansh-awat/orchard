import type { PageLoad } from './$types';
import { queryClient } from '$lib/query';
import { jobQueryOptions } from '$lib/queries/jobs';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	void queryClient.prefetchQuery(jobQueryOptions(params.id));
	return { orgSlug: params.orgSlug, jobId: params.id };
};
