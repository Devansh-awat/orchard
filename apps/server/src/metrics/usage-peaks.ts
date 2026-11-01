export const DEPLOYMENT_POD = '(.+?)(?:--green)?-[a-z0-9]+-[a-z0-9]+';
export const DATABASE_POD = '(.+)-[0-9]+';

const SELECTOR = '{namespace!="",container="",image=""}';
const CPU = `container_cpu_usage_seconds_total${SELECTOR}`;
const MEMORY = `container_memory_working_set_bytes${SELECTOR}`;

export interface AppPeaks {
  cpuP95: number | null;
  memoryP95: number | null;
  cpuPodP95: number | null;
  cpuPodP99: number | null;
  memoryPodPeak: number | null;
}

export interface DatabasePeaks {
  cpuP95: number | null;
  memoryP95: number | null;
}

export interface ClusterPeaks {
  at: number;
  rangeSeconds: number;
  apps: Record<string, AppPeaks>;
  databases: Record<string, DatabasePeaks>;
}

export function peakStep(rangeSeconds: number): number {
  return Math.max(60, Math.ceil(rangeSeconds / 1440 / 60) * 60);
}

function tag(expr: string, pattern: string): string {
  return `label_replace(${expr}, "orchard_app", "$1", "pod", "${pattern}")`;
}

function keyed(expr: string): string {
  return `label_join(${expr}, "orchard_key", "/", "namespace", "orchard_app")`;
}

export function peakQueries(rangeSeconds: number) {
  const step = peakStep(rangeSeconds);
  const podStep = Math.max(300, step);
  const range = `${Math.round(rangeSeconds)}s`;
  const cpuSum = (pattern: string) =>
    `sum by (namespace, orchard_app) (${tag(`rate(${CPU}[${step}s])`, pattern)}) * 1000`;
  const memSum = (pattern: string) => `sum by (namespace, orchard_app) (${tag(MEMORY, pattern)})`;
  const cpuPodMax = `max by (namespace, orchard_app) (${tag(`sum by (namespace, pod) (rate(${CPU}[${podStep}s]))`, DEPLOYMENT_POD)}) * 1000`;
  const memPodMax = `max by (namespace, orchard_app) (${tag(`sum by (namespace, pod) (${MEMORY})`, DEPLOYMENT_POD)})`;
  return {
    apps: {
      cpuP95: keyed(`quantile_over_time(0.95, (${cpuSum(DEPLOYMENT_POD)})[${range}:${step}s])`),
      memoryP95: keyed(`quantile_over_time(0.95, (${memSum(DEPLOYMENT_POD)})[${range}:${step}s])`),
      cpuPodP95: keyed(`quantile_over_time(0.95, (${cpuPodMax})[${range}:${podStep}s])`),
      cpuPodP99: keyed(`quantile_over_time(0.99, (${cpuPodMax})[${range}:${podStep}s])`),
      memoryPodPeak: keyed(`max_over_time((${memPodMax})[${range}:${podStep}s])`)
    },
    databases: {
      cpuP95: keyed(`quantile_over_time(0.95, (${cpuSum(DATABASE_POD)})[${range}:${step}s])`),
      memoryP95: keyed(`quantile_over_time(0.95, (${memSum(DATABASE_POD)})[${range}:${step}s])`)
    }
  };
}

type Grouped<K extends string> = Record<K, Map<string, number>>;

function assemble<K extends string>(grouped: Grouped<K>): Record<string, Record<K, number | null>> {
  const fields = Object.keys(grouped) as K[];
  const out: Record<string, Record<K, number | null>> = {};
  for (const field of fields) {
    for (const [key, value] of grouped[field]) {
      if (!key || key.endsWith('/') || !Number.isFinite(value)) continue;
      out[key] ??= Object.fromEntries(fields.map((f) => [f, null])) as Record<K, number | null>;
      out[key][field] = value;
    }
  }
  return out;
}

export function assemblePeaks(
  rangeSeconds: number,
  at: number,
  apps: Grouped<keyof AppPeaks>,
  databases: Grouped<keyof DatabasePeaks>
): ClusterPeaks {
  return { at, rangeSeconds, apps: assemble(apps), databases: assemble(databases) };
}

export function peakKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}
