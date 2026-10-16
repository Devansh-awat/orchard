import { parseCpu, parseMemory } from './quantity';
import { toQuartzCron } from '../projects/projects.utils';

export interface ClusterSpecValues {
  storageSize: string | null;
  replicas: number | null;
  pgMajor: number | null;
  sharedPreloadLibs: string[];
  cpuMilli: number | null;
  memoryBytes: number | null;
}

export interface SpecColumns {
  storageSize: string | null;
  replicas: number;
  pgMajor: number;
  sharedPreloadLibs: unknown;
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | null;
}

export interface ResolvedResources {
  current: { cpuMilli: number; memoryBytes: number };
  defaults: { cpuMilli: number; memoryBytes: number };
}

export type SpecColumnUpdate = Partial<{
  storageSize: string;
  replicas: number;
  pgMajor: number;
  sharedPreloadLibs: string[];
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | null;
}>;

export function majorFromImage(imageName: unknown): number | null {
  if (typeof imageName !== 'string') return null;
  const tag = imageName.split('@')[0].split('/').pop()?.split(':')[1];
  const major = tag?.match(/^(\d+)/)?.[1];
  return major ? Number(major) : null;
}

export function clusterSpecValues(cluster: any): ClusterSpecValues {
  const spec = cluster?.spec ?? {};
  const size = typeof spec.storage?.size === 'string' ? spec.storage.size.trim() : '';
  const instances = Number(spec.instances);
  const libs = spec.postgresql?.shared_preload_libraries;
  const cpu = parseCpu(String(spec.resources?.limits?.cpu ?? ''));
  const memory = parseMemory(String(spec.resources?.limits?.memory ?? ''));
  return {
    storageSize: size || null,
    replicas: Number.isInteger(instances) && instances > 0 ? instances : null,
    pgMajor: majorFromImage(spec.imageName),
    sharedPreloadLibs: Array.isArray(libs) ? libs.filter((l) => typeof l === 'string') : [],
    cpuMilli: cpu > 0 ? cpu : null,
    memoryBytes: memory > 0 ? memory : null
  };
}

function sameList(a: unknown, b: string[]): boolean {
  const list = Array.isArray(a) ? a : [];
  return list.length === b.length && list.every((v, i) => v === b[i]);
}

function pinnedOrDefault(
  live: number,
  current: number,
  fallback: number
): number | null | undefined {
  if (live === current) return undefined;
  return live === fallback ? null : live;
}

export function specColumnUpdate(
  row: SpecColumns,
  live: ClusterSpecValues,
  resources: ResolvedResources | null
): SpecColumnUpdate {
  const update: SpecColumnUpdate = {};
  if (live.storageSize && live.storageSize !== row.storageSize) {
    update.storageSize = live.storageSize;
  }
  if (live.replicas != null && live.replicas !== row.replicas) update.replicas = live.replicas;
  if (live.pgMajor != null && live.pgMajor !== row.pgMajor) update.pgMajor = live.pgMajor;
  if (!sameList(row.sharedPreloadLibs, live.sharedPreloadLibs)) {
    update.sharedPreloadLibs = live.sharedPreloadLibs;
  }
  if (resources && live.cpuMilli != null) {
    const cpu = pinnedOrDefault(
      live.cpuMilli,
      resources.current.cpuMilli,
      resources.defaults.cpuMilli
    );
    if (cpu !== undefined && cpu !== row.cpuRequestMilli) update.cpuRequestMilli = cpu;
  }
  if (resources && live.memoryBytes != null) {
    const memory = pinnedOrDefault(
      live.memoryBytes,
      resources.current.memoryBytes,
      resources.defaults.memoryBytes
    );
    if (memory !== undefined) {
      const next = memory === null ? null : BigInt(memory);
      if (next !== row.memoryRequestBytes) update.memoryRequestBytes = next;
    }
  }
  return update;
}

export function parameterDrift(
  stored: Record<string, string>,
  baseline: Record<string, string>,
  live: Record<string, unknown> | null | undefined,
  keys: string[]
): Record<string, string | null> {
  const drift: Record<string, string | null> = {};
  if (!live) return drift;
  for (const key of keys) {
    const running = typeof live[key] === 'string' ? (live[key] as string) : undefined;
    if (key in stored) {
      if (running !== stored[key]) drift[key] = running ?? null;
      continue;
    }
    if (running !== undefined && running !== baseline[key]) drift[key] = running;
  }
  return drift;
}

export interface ScheduleColumns {
  backupScheduleCron: string | null;
  backupScheduleDisabled: boolean;
}

export function cronFromSchedule(schedule: string): string {
  const parts = schedule.trim().split(/\s+/).filter(Boolean);
  return parts.length === 6 && parts[0] === '0' ? parts.slice(1).join(' ') : parts.join(' ');
}

export function scheduleCronUpdate(row: ScheduleColumns, schedule: unknown): string | null {
  if (typeof schedule !== 'string') return null;
  const live = schedule.trim().split(/\s+/).filter(Boolean).join(' ');
  if (!live) return null;
  if (
    !row.backupScheduleDisabled &&
    row.backupScheduleCron &&
    toQuartzCron(row.backupScheduleCron) === live
  ) {
    return null;
  }
  return cronFromSchedule(live);
}

export const HIBERNATION_ANNOTATION = 'cnpg.io/hibernation';

const HIBERNATION_LEAVES_ALONE = new Set(['deleting', 'provisioning', 'restoring']);

export function hibernationTransition(
  cluster: any,
  status: string
): 'stopped' | 'restarting' | null {
  if (HIBERNATION_LEAVES_ALONE.has(status)) return null;
  const on = cluster?.metadata?.annotations?.[HIBERNATION_ANNOTATION] === 'on';
  if (on && status !== 'stopped') return 'stopped';
  if (!on && status === 'stopped') return 'restarting';
  return null;
}
