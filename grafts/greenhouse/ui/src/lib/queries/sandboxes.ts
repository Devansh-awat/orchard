import type { QueryClient } from '@tanstack/svelte-query';
import { apiFetch } from '../../host/stores';
import { isSandboxTransitional } from '../types/sandbox';
import type {
  Sandbox,
  SandboxBoot,
  SandboxCredentials,
  SandboxListResponse,
  SandboxStatus,
  SshIdentitiesResponse,
  SshIdentity
} from '../types/sandbox';

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
    refetchInterval: (query: { state: { data?: SandboxListResponse } }) => {
      const sandboxes = query.state.data?.sandboxes ?? [];
      return sandboxes.some((s) => isSandboxTransitional(s.status) || s.applying) ? 3_000 : 30_000;
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
      return sandbox && isSandboxTransitional(sandbox.status) ? 3_000 : 30_000;
    },
    retry: sandboxRetry
  };
}

export function sandboxBootQueryOptions(id: string, enabled: boolean) {
  return {
    queryKey: ['sandbox-boot', id],
    enabled: enabled && !!id,
    queryFn: async (): Promise<SandboxBoot> => {
      const res = await apiFetch(`/apiv1/sandboxes/${id}/boot`);
      if (!res.ok) throw new Error('Failed to fetch boot progress');
      return res.json();
    },
    refetchInterval: (query: { state: { data?: SandboxBoot } }) =>
      query.state.data?.ready ? (false as const) : 3_000,
    retry: false,
    gcTime: 60_000
  };
}

function isSandboxList(value: unknown): value is SandboxListResponse {
  return (
    !!value && typeof value === 'object' && Array.isArray((value as SandboxListResponse).sandboxes)
  );
}

export function optimisticSandboxStatus(client: QueryClient, id: string, status: SandboxStatus) {
  client.setQueryData(['sandboxes', id], (old: Sandbox | undefined) =>
    old ? { ...old, status } : old
  );
  client.setQueriesData({ queryKey: ['sandboxes'] }, (old: unknown) => {
    if (!isSandboxList(old)) return old;
    return {
      ...old,
      sandboxes: old.sandboxes.map((s) => (s.id === id ? { ...s, status } : s))
    };
  });
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
