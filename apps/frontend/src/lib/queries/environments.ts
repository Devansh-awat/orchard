import { apiFetch } from '$lib/stores';
import type { Environment, SharedVar } from '$lib/types/environments';

export function environmentsQueryOptions(projectId: string) {
	return {
		queryKey: ['environments', projectId],
		queryFn: async (): Promise<Environment[]> => {
			const res = await apiFetch(`/apiv1/projects/${projectId}/environments`);
			if (!res.ok) throw new Error('Failed to fetch environments');
			return res.json();
		}
	};
}

export function sharedVarsQueryOptions(environmentId: string) {
	return {
		queryKey: ['shared-vars', environmentId],
		queryFn: async (): Promise<SharedVar[]> => {
			const res = await apiFetch(`/apiv1/environments/${environmentId}/shared-vars`);
			if (!res.ok) throw new Error('Failed to fetch shared variables');
			return res.json();
		}
	};
}
