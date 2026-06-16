import type { PageLoad } from './$types';
import { queryClient } from '$lib/query';
import { deploymentQueryOptions } from '$lib/queries/deployment';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	void queryClient.prefetchQuery(deploymentQueryOptions(params.id));
	return { deploymentId: params.id };
};
