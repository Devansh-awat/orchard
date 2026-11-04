import { MANAGED_DATABASE_MIN_MEMORY_BYTES } from './presets';
import { parsePgMemory, SHARED_BUFFERS_FRACTION } from './db-tuning';
import { parseCpu, parseMemory } from './quantity';
import { NO_LIMITS_ANNOTATION, NO_LIMITS_APP_REQUESTS } from './resource-spec';

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

export interface PodDefaults {
  cpuMilli: number;
  memoryBytes: number;
}

export interface TenantLimitRange {
  defaultRequest: Record<string, string>;
  defaultLimit: Record<string, string>;
}

export function tenantLimitRange(
  hard: Record<string, string>,
  request: PodDefaults,
  limit: PodDefaults
): TenantLimitRange {
  const defaultLimit: Record<string, string> = {};
  if (hard['limits.cpu'] !== undefined) defaultLimit.cpu = `${limit.cpuMilli}m`;
  if (hard['limits.memory'] !== undefined) defaultLimit.memory = String(limit.memoryBytes);
  return {
    defaultRequest: { cpu: `${request.cpuMilli}m`, memory: String(request.memoryBytes) },
    defaultLimit
  };
}

export interface MirroredWorkload {
  kind: string;
  manifest: any;
}

export interface NamespaceRoom {
  hasWorkloadWithoutLimits: boolean;
  defaultLimit: PodDefaults;
  needed: PodDefaults;
}

interface ContainerResources {
  requests?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

function workloadPods(workload: MirroredWorkload): {
  containers: ContainerResources[];
  copies: number;
  database: any | null;
  limitsOffWorkload: boolean;
} | null {
  const { kind, manifest } = workload;
  const resourcesOf = (spec: any): ContainerResources[] =>
    (spec?.containers ?? []).map((c: any) => c?.resources ?? {});
  if (kind === 'Deployment') {
    return {
      containers: resourcesOf(manifest?.spec?.template?.spec),
      copies: manifest?.spec?.replicas ?? 1,
      database: null,
      limitsOffWorkload: manifest?.metadata?.annotations?.[NO_LIMITS_ANNOTATION] === 'true'
    };
  }
  if (kind === 'CronJob') {
    return {
      containers: resourcesOf(manifest?.spec?.jobTemplate?.spec?.template?.spec),
      copies: 1,
      database: null,
      limitsOffWorkload: false
    };
  }
  if (kind === 'Cluster') {
    return {
      containers: [manifest?.spec?.resources ?? {}],
      copies: manifest?.spec?.instances ?? 1,
      database: manifest,
      limitsOffWorkload: true
    };
  }
  return null;
}

const quantity = (raw: unknown, parse: (value: string) => number): number | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = parse(String(raw));
  return value > 0 ? value : null;
};

export function namespaceRoom(workloads: MirroredWorkload[], defaults: PodDefaults): NamespaceRoom {
  const defaultLimit = {
    cpuMilli: Math.max(defaults.cpuMilli, NO_LIMITS_APP_REQUESTS.cpuMilli),
    memoryBytes: Math.max(defaults.memoryBytes, NO_LIMITS_APP_REQUESTS.memoryBytes)
  };
  let hasWorkloadWithoutLimits = false;
  const pods = workloads
    .map(workloadPods)
    .filter((pod): pod is NonNullable<typeof pod> => pod !== null);

  for (const pod of pods) {
    for (const resources of pod.containers) {
      const cpuLimit = quantity(resources.limits?.cpu, parseCpu);
      const memoryLimit = quantity(resources.limits?.memory, parseMemory);
      if (pod.limitsOffWorkload && (cpuLimit === null || memoryLimit === null)) {
        hasWorkloadWithoutLimits = true;
      }
      if (cpuLimit === null) {
        const asked = quantity(resources.requests?.cpu, parseCpu) ?? 0;
        defaultLimit.cpuMilli = Math.max(defaultLimit.cpuMilli, asked);
      }
      if (memoryLimit === null) {
        const asked = quantity(resources.requests?.memory, parseMemory) ?? 0;
        const buffers = pod.database
          ? parsePgMemory(pod.database.spec?.postgresql?.parameters?.shared_buffers ?? '') /
            SHARED_BUFFERS_FRACTION
          : 0;
        const floor = pod.database ? MANAGED_DATABASE_MIN_MEMORY_BYTES : 0;
        defaultLimit.memoryBytes = Math.max(defaultLimit.memoryBytes, asked, buffers, floor);
      }
    }
  }

  const needed = { cpuMilli: 0, memoryBytes: 0 };
  for (const pod of pods) {
    const copies = Math.max(0, Number(pod.copies) || 0);
    for (const resources of pod.containers) {
      needed.cpuMilli +=
        copies * (quantity(resources.limits?.cpu, parseCpu) ?? defaultLimit.cpuMilli);
      needed.memoryBytes +=
        copies * (quantity(resources.limits?.memory, parseMemory) ?? defaultLimit.memoryBytes);
    }
  }
  return { hasWorkloadWithoutLimits, defaultLimit, needed };
}
