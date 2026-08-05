import { apiFetch } from '$lib/stores';
import { isSandboxTransitional } from '$lib/types/sandbox';
import type {
	Sandbox,
	SandboxCredentials,
	SandboxListResponse,
	SshIdentitiesResponse,
	SshIdentity
} from '$lib/types/sandbox';

export class SandboxDisabledError extends Error {
	constructor() {
		super('Sandbox feature is not enabled on this server');
		this.name = 'SandboxDisabledError';
	}
}

function sandboxRetry(failureCount: number, error: Error) {
	return !(error instanceof SandboxDisabledError) && failureCount < 1;
}

export function sandboxesQueryOptions(organizationId?: string) {
	return {
		queryKey: ['sandboxes', organizationId ?? null],
		queryFn: async (): Promise<SandboxListResponse> => {
			const res = await apiFetch(
				organizationId
					? `/apiv1/sandboxes?organizationId=${encodeURIComponent(organizationId)}`
					: '/apiv1/sandboxes'
			);
			if (res.status === 404) throw new SandboxDisabledError();
			if (!res.ok) throw new Error('Failed to fetch sandboxes');
			return res.json();
		},
		retry: sandboxRetry
	};
}

export function sandboxQueryOptions(id: string) {
	return {
		queryKey: ['sandboxes', id],
		queryFn: async (): Promise<Sandbox> => {
			const res = await apiFetch(`/apiv1/sandboxes/${id}`);
			if (res.status === 404) throw new Error('Sandbox not found');
			if (!res.ok) throw new Error('Failed to fetch sandbox');
			const data = await res.json();
			return (data?.sandbox ?? data) as Sandbox;
		},
		refetchInterval: (query: { state: { data?: Sandbox } }) => {
			const sandbox = query.state.data;
			return sandbox && isSandboxTransitional(sandbox.status) ? 5_000 : 30_000;
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

export function sshIdentitiesQueryOptions() {
	return {
		queryKey: ['ssh-identities'],
		queryFn: async (): Promise<SshIdentity[]> => {
			const res = await apiFetch('/apiv1/ssh-identities');
			if (res.status === 404) throw new SandboxDisabledError();
			if (!res.ok) throw new Error('Failed to fetch SSH identities');
			const data: SshIdentitiesResponse = await res.json();
			return data.identities ?? [];
		},
		retry: sandboxRetry
	};
}
