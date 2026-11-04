import { parseCpu, parseMemory } from './quantity';
import { deriveDbTuning, MANAGED_DB_MIN_MEMORY_BYTES, parsePgMemory } from './db-tuning';
import { normalizePgParam, ORCHARD_PG_DEFAULTS, PG_PARAM_BOUNDS } from './pg-params';
import { toQuartzCron } from '../projects/projects.utils';
import {
  containerResourcesPatch,
  databaseSizing,
  hasLimits,
  type PodSizing
} from './resource-spec';

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

export const APPLIED_SHARED_BUFFERS_ANNOTATION = 'orchard.my/applied-shared-buffers';

export function appliedSharedBuffers(value: unknown): Record<string, string> | undefined {
  return typeof value === 'string' && value
    ? { [APPLIED_SHARED_BUFFERS_ANNOTATION]: value }
    : undefined;
}

export function sharedBuffersStamp(
  cluster: any,
  tuningPatch: Record<string, any> | null
): Record<string, string> | undefined {
  const written = tuningPatch?.postgresql?.parameters?.shared_buffers;
  if (written) return appliedSharedBuffers(written);
  if (cluster?.metadata?.annotations?.[APPLIED_SHARED_BUFFERS_ANNOTATION]) return undefined;
  return appliedSharedBuffers(cluster?.spec?.postgresql?.parameters?.shared_buffers);
}

function clusterAlreadySized(cluster: any, size: PodSizing): boolean {
  const live = cluster?.spec?.resources;
  if (size.noLimits) return !hasLimits(live);
  return (
    parseCpu(String(live?.limits?.cpu ?? '')) === size.cpuMilli &&
    parseMemory(String(live?.limits?.memory ?? '')) === size.memoryBytes
  );
}

export function clusterRestartPatch(
  cluster: any,
  size: PodSizing,
  tuning: { sharedBuffers: string; dataCompression: 'gzip' | null } | null,
  now: Date = new Date()
): Record<string, any> {
  const annotations: Record<string, string> = { 'cnpg.io/restartedAt': now.toISOString() };
  if (clusterAlreadySized(cluster, size)) return { metadata: { annotations } };

  const liveBuffers = cluster?.spec?.postgresql?.parameters?.shared_buffers;
  const spec: Record<string, any> = {
    resources: containerResourcesPatch(databaseSizing(size, liveBuffers))
  };
  if (!size.noLimits && tuning) {
    Object.assign(annotations, appliedSharedBuffers(tuning.sharedBuffers));
    spec.postgresql = { parameters: { shared_buffers: tuning.sharedBuffers } };
    if (cluster?.spec?.backup?.barmanObjectStore) {
      spec.backup = {
        barmanObjectStore: {
          data: tuning.dataCompression ? { compression: tuning.dataCompression } : null
        }
      };
    }
  }
  return { metadata: { annotations }, spec };
}

const ADOPTABLE_SHARED_BUFFERS_FRACTION = 0.4;
const MASS_REMOVAL_MIN = 2;
const SAFE_GZIP_MEMORY_BYTES = 512 * 1024 * 1024;

export interface ParameterAdoption {
  parameters: Record<string, string>;
  changed: string[];
  refused: string[];
}

export function planParameterAdoption(
  cluster: any,
  stored: Record<string, string>
): ParameterAdoption | null {
  const live: Record<string, unknown> = cluster?.spec?.postgresql?.parameters ?? {};
  const limit = parseMemory(String(cluster?.spec?.resources?.limits?.memory ?? ''));
  const next = { ...stored };
  const changed: string[] = [];
  const refused: string[] = [];

  const storedKeys = Object.keys(stored).filter((key) => key !== 'shared_buffers');
  const vanished = storedKeys.filter((key) => live[key] === undefined || live[key] === null);
  const holdRemovals = vanished.length >= MASS_REMOVAL_MIN && vanished.length === storedKeys.length;

  for (const key of Object.keys(PG_PARAM_BOUNDS)) {
    if (key === 'shared_buffers') continue;
    const raw = live[key];
    if (raw === undefined || raw === null) {
      if (!(key in next)) continue;
      if (holdRemovals) {
        refused.push(key);
        continue;
      }
      delete next[key];
      changed.push(key);
      continue;
    }
    const value = normalizePgParam(key, raw);
    if (value === null) {
      refused.push(key);
      continue;
    }
    if (value === stored[key]) continue;
    if (stored[key] === undefined && ORCHARD_PG_DEFAULTS[key] === value) continue;
    next[key] = value;
    changed.push(key);
  }

  const stamp = cluster?.metadata?.annotations?.[APPLIED_SHARED_BUFFERS_ANNOTATION];
  const liveBuffers = live.shared_buffers;
  if (stamp && typeof liveBuffers === 'string' && liveBuffers !== stamp) {
    const value = normalizePgParam('shared_buffers', liveBuffers);
    const safe =
      value !== null &&
      (limit === 0 || parsePgMemory(value) <= limit * ADOPTABLE_SHARED_BUFFERS_FRACTION);
    if (!safe) refused.push('shared_buffers');
    else if (value !== stored.shared_buffers) {
      next.shared_buffers = value;
      changed.push('shared_buffers');
    }
  }

  return changed.length > 0 || refused.length > 0 ? { parameters: next, changed, refused } : null;
}

export function planCompressionAdoption(
  cluster: any,
  stored: string | null
): 'gzip' | 'none' | null {
  const store = cluster?.spec?.backup?.barmanObjectStore;
  if (!store) return null;
  const live = store.data?.compression === 'gzip' ? 'gzip' : null;
  const limit = parseMemory(String(cluster?.spec?.resources?.limits?.memory ?? ''));
  const expected = deriveDbTuning({
    memoryLimitBytes: Math.max(limit, MANAGED_DB_MIN_MEMORY_BYTES),
    overrides: { backupCompression: stored }
  }).dataCompression;
  if (live === expected) return null;
  if (live === 'gzip' && Math.max(limit, MANAGED_DB_MIN_MEMORY_BYTES) < SAFE_GZIP_MEMORY_BYTES) {
    return null;
  }
  return live === 'gzip' ? 'gzip' : 'none';
}
