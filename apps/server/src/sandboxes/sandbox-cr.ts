// The Sandbox custom resource, described in one place. The k8s service, the
// mirror shard and the informer consumer all need these names and this reading
// of a manifest; keeping it here is what lets the mirror depend on sandboxes
// without sandboxes depending back.

export const CRD_GROUP = 'agents.x-k8s.io';
export const CRD_VERSION = 'v1beta1';
export const CRD_PLURAL = 'sandboxes';
export const CRD_KIND = 'Sandbox';
export const CRD_API_VERSION = `${CRD_GROUP}/${CRD_VERSION}`;

export const MANAGED_BY = 'orchard-sandbox';
export const INSTANCE_LABEL = 'orchard.my/instance';
export const SANDBOX_ID_LABEL = 'orchard.my/sandbox-id';
export const INSTANCE_SETTING_KEY = 'sandbox_instance_id';

export const SANDBOX_SHARD = 'sandboxes';

export interface SandboxCrStatus {
  exists: boolean;
  operatingMode: 'Running' | 'Suspended' | null;
  ready: boolean;
  message: string | null;
  podIp: string | null;
}

export const SANDBOX_CR_ABSENT: SandboxCrStatus = {
  exists: false,
  operatingMode: null,
  ready: false,
  message: null,
  podIp: null,
};

export function readSandboxCr(cr: any): SandboxCrStatus {
  const conditions: { type?: string; status?: string; message?: string }[] =
    cr?.status?.conditions ?? [];
  const failing = conditions.find((c) => c.status === 'False' && c.message);
  return {
    exists: true,
    operatingMode: cr?.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running',
    ready: conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
    message: failing?.message || null,
    podIp: Array.isArray(cr?.status?.podIPs) && cr.status.podIPs.length
      ? String(cr.status.podIPs[0])
      : null,
  };
}

// What the sandbox row should say, given the resource the cluster actually
// holds. `null` means the resource is mid-flight — created but not ready, or
// resuming — and whatever the row already says still stands.
export function sandboxStatusFromCr(cr: SandboxCrStatus): 'running' | 'stopped' | null {
  if (!cr.exists) return null;
  if (cr.operatingMode === 'Suspended') return 'stopped';
  return cr.ready ? 'running' : null;
}
