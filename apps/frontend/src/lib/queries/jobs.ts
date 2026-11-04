import { apiFetch } from '$lib/stores';
import type { Job, JobRun, JobRunsPage } from '$lib/types/jobs';

export function jobsQueryOptions(orgId: string) {
	return {
		queryKey: ['jobs', orgId],
		queryFn: async (): Promise<Job[]> => {
			const res = await apiFetch(`/apiv1/organizations/${orgId}/jobs`);
			if (!res.ok) throw new Error("Couldn't load jobs");
			return res.json();
		}
	};
}

export function jobQueryOptions(jobId: string) {
	return {
		queryKey: ['job', jobId],
		queryFn: async (): Promise<Job> => {
			const res = await apiFetch(`/apiv1/jobs/${jobId}`);
			if (!res.ok) throw new Error("Couldn't load job");
			return res.json();
		}
	};
}

export function jobRunsQueryOptions(jobId: string) {
	return {
		queryKey: ['job-runs', jobId],
		queryFn: async (): Promise<JobRunsPage> => {
			const res = await apiFetch(`/apiv1/jobs/${jobId}/runs`);
			if (!res.ok) throw new Error("Couldn't load runs");
			return res.json();
		}
	};
}

export function jobRunQueryOptions(runId: string) {
	return {
		queryKey: ['job-run', runId],
		queryFn: async (): Promise<JobRun> => {
			const res = await apiFetch(`/apiv1/job-runs/${runId}`);
			if (!res.ok) throw new Error("Couldn't load run");
			return res.json();
		}
	};
}
