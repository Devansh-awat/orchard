import { apiFetch } from '../../../host/stores';

export type AgentUsageWindow = {
  usedPercent: number;
  leftPercent: number;
  resetsAt: string | null;
};

export type AgentUsage =
  | {
      available: true;
      provider: string;
      loginMethod: string;
      plan: string | null;
      email: string | null;
      emailMasked: boolean;
      fiveHour: AgentUsageWindow | null;
      sevenDay: AgentUsageWindow | null;
      fetchedAt: string;
    }
  | { available: false; reason: 'no_token' | 'api_key' | 'unavailable' | 'forbidden' };

export function agentUsageQueryOptions(sandboxId: string, enabled: boolean) {
  return {
    queryKey: ['sandbox-agent-usage', sandboxId],
    enabled: enabled && !!sandboxId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<AgentUsage> => {
      const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/agent/usage`);
      if (res.status === 403) return { available: false, reason: 'forbidden' };
      if (!res.ok) return { available: false, reason: 'unavailable' };
      return (await res.json()) as AgentUsage;
    }
  };
}

export function usageUnavailableText(reason: Exclude<AgentUsage, { available: true }>['reason']) {
  if (reason === 'api_key') return 'Usage is only available for Claude subscription logins';
  if (reason === 'no_token') return 'The host has no Claude login';
  return 'Usage is unavailable right now';
}

export function fmtResetTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}
