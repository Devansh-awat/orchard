import { apiFetch } from '$lib/stores';

export function deploymentQueryOptions(deploymentId: string) {
	return {
		queryKey: ['deployment', deploymentId],
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}`);
			if (!res.ok) throw new Error("Couldn't load deployment");
			return res.json();
		}
	};
}
