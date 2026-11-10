import { parseMemory } from '../kubernetes/quantity';

export type LimitValue = number | 'off';
export type LimitFallback = LimitValue | 'auto';
export type LimitUnit = 'count' | 'GiB';

interface LimitSpec {
  env: string;
  fallback: LimitFallback;
  min: number;
  unit: LimitUnit;
  offable: boolean;
  envZeroIsOff: boolean;
  envQuantity: boolean;
}

const count = <F extends LimitFallback>(
  env: string,
  fallback: F,
  opts: Partial<Omit<LimitSpec, 'env' | 'fallback'>> = {}
): LimitSpec & { fallback: F } => ({
  env,
  fallback,
  min: 1,
  unit: 'count',
  offable: true,
  envZeroIsOff: true,
  envQuantity: false,
  ...opts
});

export const INSTANCE_LIMITS = {
  publicPortsPerOrg: count('MAX_PUBLIC_PORTS_PER_ORG', 20),
  customDomainsPerOrg: count('MAX_CUSTOM_DOMAINS_PER_ORG', 250),
  customDomainCreatesPerHour: count('MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR', 30),
  projectsPerOrg: count('MAX_PROJECTS_PER_ORG', 'off'),
  environmentsPerOrg: count('MAX_ENVIRONMENTS_PER_ORG', 'off'),
  deploymentsPerOrg: count('MAX_DEPLOYMENTS_PER_ORG', 'off'),
  buildsPerOrg: count('MAX_CONCURRENT_BUILDS_PER_ORG', 'auto'),
  scansPerOrg: count('TRIVY_MAX_SCANS_PER_ORG', 1, { envZeroIsOff: false }),
  volumeSizeGiB: count('MAX_VOLUME_SIZE', 200, {
    unit: 'GiB',
    envZeroIsOff: false,
    envQuantity: true
  }),
  databaseReplicas: count('MAX_DATABASE_REPLICAS', 5, { offable: false, envZeroIsOff: false }),
  namespaceLoadBalancers: count('TENANT_QUOTA_FLOOR_LOADBALANCERS', 20, {
    min: 0,
    envZeroIsOff: false
  }),
  namespaceNodePorts: count('TENANT_QUOTA_FLOOR_NODEPORTS', 10, { min: 0, envZeroIsOff: false }),
  ephemeralStorageGiB: count('TENANT_EPHEMERAL_STORAGE_LIMIT_GIB', 20, { unit: 'GiB' })
} satisfies Record<string, LimitSpec>;

export type InstanceLimitName = keyof typeof INSTANCE_LIMITS;

export const INSTANCE_LIMIT_NAMES = Object.keys(INSTANCE_LIMITS) as InstanceLimitName[];

export const NODE_PORT_EXPOSURE_FIELD = 'nodePortExposure';
export const NODE_PORT_EXPOSURE_ENV = 'TENANT_NODEPORT_EXPOSURE';

const GiB = 1024 ** 3;
const VOLUME_QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|K|M|G|T)?$/;

let stored: Partial<Record<InstanceLimitName, LimitValue>> = {};
let storedNodePortExposure: boolean | null = null;

export function isInstanceLimitName(name: string): name is InstanceLimitName {
  return Object.prototype.hasOwnProperty.call(INSTANCE_LIMITS, name);
}

export function parseStoredLimit(name: InstanceLimitName, raw: unknown): LimitValue | null {
  const spec: LimitSpec = INSTANCE_LIMITS[name];
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (text.toLowerCase() === 'off') return spec.offable ? 'off' : null;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= spec.min ? value : null;
}

export function storedLimitError(name: InstanceLimitName, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (parseStoredLimit(name, raw) !== null) return null;
  const spec: LimitSpec = INSTANCE_LIMITS[name];
  const floor = spec.min === 0 ? 'zero or more' : `${spec.min} or more`;
  return spec.offable
    ? `${name} must be a whole number, ${floor}, or off`
    : `${name} must be a whole number, ${floor}`;
}

function envText(spec: LimitSpec, env: NodeJS.ProcessEnv): string | null {
  const raw = env[spec.env]?.trim();
  return raw ? raw : null;
}

function parseEnvLimit(spec: LimitSpec, raw: string): LimitFallback {
  if (spec.envQuantity) {
    return VOLUME_QUANTITY.test(raw) ? parseMemory(raw) / GiB : spec.fallback;
  }
  if (spec.unit === 'GiB') {
    const gib = Number(raw);
    if (!Number.isFinite(gib) || gib < 0) return spec.fallback;
    return gib === 0 && spec.envZeroIsOff ? 'off' : gib;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return spec.fallback;
  if (value === 0 && spec.envZeroIsOff) return 'off';
  return value >= spec.min ? value : spec.fallback;
}

export function isLimitPinned(
  name: InstanceLimitName,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return envText(INSTANCE_LIMITS[name], env) !== null;
}

export function storedLimit(name: InstanceLimitName): LimitValue | null {
  return stored[name] ?? null;
}

export function resolveLimit(
  name: InstanceLimitName,
  env: NodeJS.ProcessEnv = process.env
): LimitFallback {
  const spec: LimitSpec = INSTANCE_LIMITS[name];
  const pinned = envText(spec, env);
  if (pinned !== null) return parseEnvLimit(spec, pinned);
  return stored[name] ?? spec.fallback;
}

export function countLimit(name: InstanceLimitName, env: NodeJS.ProcessEnv = process.env): number {
  const value = resolveLimit(name, env);
  return typeof value === 'number' ? value : 0;
}

export function isNodePortExposurePinned(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[NODE_PORT_EXPOSURE_ENV]?.trim();
}

export function storedNodePortExposureValue(): boolean | null {
  return storedNodePortExposure;
}

export function nodePortExposureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const pinned = env[NODE_PORT_EXPOSURE_ENV]?.trim();
  if (pinned) return pinned.toLowerCase() !== 'false';
  return storedNodePortExposure ?? true;
}

export function setInstanceLimitOverrides(values: Record<string, string | null | undefined>): void {
  const next: Partial<Record<InstanceLimitName, LimitValue>> = {};
  for (const name of INSTANCE_LIMIT_NAMES) {
    const parsed = parseStoredLimit(name, values[name]);
    if (parsed !== null) next[name] = parsed;
  }
  stored = next;
  const flag = values[NODE_PORT_EXPOSURE_FIELD]?.trim().toLowerCase();
  storedNodePortExposure = flag === 'true' ? true : flag === 'false' ? false : null;
}
