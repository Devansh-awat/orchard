import type { PageLoad } from './$types';
import { queryClient } from '$lib/query';
import { jobRunQueryOptions } from '$lib/queries/jobs';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	void queryClient.prefetchQuery(jobRunQueryOptions(params.runId));
	return { orgSlug: params.orgSlug, jobId: params.id, runId: params.runId };
};
