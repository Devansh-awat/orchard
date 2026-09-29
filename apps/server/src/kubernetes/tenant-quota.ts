export interface TenantQuotaCaps {
  cpuLimitMilli?: number | null;
  memoryLimitBytes?: number | null;
  maxPods?: number | null;
  maxServices?: number | null;
}

export interface TenantQuotaFloor {
  pods: number;
  services: number;
  persistentvolumeclaims: number;
  storageBytes: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function tenantQuotaFloor(env: NodeJS.ProcessEnv): TenantQuotaFloor {
  return {
    pods: positive(env.TENANT_QUOTA_FLOOR_PODS, 200),
    services: positive(env.TENANT_QUOTA_FLOOR_SERVICES, 100),
    persistentvolumeclaims: positive(env.TENANT_QUOTA_FLOOR_PVCS, 50),
    storageBytes: positive(env.TENANT_QUOTA_FLOOR_STORAGE_BYTES, 500 * 1024 ** 3)
  };
}

export function tenantQuotaHard(
  caps: TenantQuotaCaps,
  floor: TenantQuotaFloor
): Record<string, string> {
  const hard: Record<string, string> = {};
  if (caps.cpuLimitMilli && caps.cpuLimitMilli > 0) {
    hard['requests.cpu'] = `${caps.cpuLimitMilli}m`;
    hard['limits.cpu'] = `${caps.cpuLimitMilli}m`;
  }
  if (caps.memoryLimitBytes && caps.memoryLimitBytes > 0) {
    hard['requests.memory'] = String(caps.memoryLimitBytes);
    hard['limits.memory'] = String(caps.memoryLimitBytes);
  }
  hard['pods'] = String(caps.maxPods && caps.maxPods > 0 ? caps.maxPods : floor.pods);
  hard['services'] = String(
    caps.maxServices && caps.maxServices > 0 ? caps.maxServices : floor.services
  );
  hard['persistentvolumeclaims'] = String(floor.persistentvolumeclaims);
  hard['requests.storage'] = String(floor.storageBytes);
  return hard;
}
