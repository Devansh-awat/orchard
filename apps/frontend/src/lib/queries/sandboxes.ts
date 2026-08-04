import { apiFetch } from '$lib/stores';
import type { SandboxCredentials, SandboxListResponse } from '$lib/types/sandbox';

export class SandboxDisabledError extends Error {
	constructor() {
		super('Sandbox feature is not enabled on this server');
		this.name = 'SandboxDisabledError';
	}
}

function sandboxRetry(failureCount: number, error: Error) {
	return !(error instanceof SandboxDisabledError) && failureCount < 1;
}

export function sandboxesQueryOptions() {
	return {
		queryKey: ['sandboxes'],
		queryFn: async (): Promise<SandboxListResponse> => {
			const res = await apiFetch('/apiv1/sandboxes');
			if (res.status === 404) throw new SandboxDisabledError();
			if (!res.ok) throw new Error('Failed to fetch sandboxes');
			return res.json();
		},
		retry: sandboxRetry
	};
}

export function sandboxCredentialsQueryOptions() {
	return {
		queryKey: ['sandbox-credentials'],
		queryFn: async (): Promise<SandboxCredentials> => {
			const res = await apiFetch('/apiv1/sandboxes/credentials');
			if (res.status === 404) throw new SandboxDisabledError();
			if (!res.ok) throw new Error('Failed to fetch sandbox credentials');
			return res.json();
		},
		retry: sandboxRetry
	};
}
