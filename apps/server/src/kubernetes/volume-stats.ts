import { parseMemory } from './quantity';

export const WRITE_GUARD_ENTER = 0.92;

export const WRITE_GUARD_EXIT = 0.85;

export interface VolumeUsage {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number | null;
  shared?: boolean;
}

export interface DiskUsage {
  usedBytes: number;
  capacityBytes: number;
}

const SHARED_USED_TOLERANCE = 0.01;

function onFilesystem(used: number, capacity: number, fs: any): boolean {
  const fsCapacity = Number(fs?.capacityBytes);
  const fsUsed = Number(fs?.usedBytes);
  if (!(fsCapacity > 0) || !Number.isFinite(fsUsed) || fsCapacity !== capacity) return false;
  return Math.abs(fsUsed - used) <= capacity * SHARED_USED_TOLERANCE;
}

export function fullerOf(a: DiskUsage, b: DiskUsage | null): DiskUsage {
  if (!b || !(b.capacityBytes > 0)) return a;
  return b.usedBytes / b.capacityBytes > a.usedBytes / a.capacityBytes ? b : a;
}

export function volumeKey(namespace: string, pvcName: string): string {
  return `${namespace}/${pvcName}`;
}

export function parseKubeletSummary(summary: unknown): Map<string, VolumeUsage> {
  const out = new Map<string, VolumeUsage>();
  const pods: any[] = Array.isArray((summary as any)?.pods) ? (summary as any).pods : [];
  const nodeFs = (summary as any)?.node?.fs;
  const imageFs = (summary as any)?.node?.runtime?.imageFs;
  for (const pod of pods) {
    const volumes: any[] = Array.isArray(pod?.volume) ? pod.volume : [];
    for (const vol of volumes) {
      const ns = vol?.pvcRef?.namespace;
      const name = vol?.pvcRef?.name;
      const used = Number(vol?.usedBytes);
      const capacity = Number(vol?.capacityBytes);
      if (!ns || !name || !Number.isFinite(used) || !(capacity > 0)) continue;
      const available = Number(vol?.availableBytes);
      const shared = onFilesystem(used, capacity, nodeFs) || onFilesystem(used, capacity, imageFs);
      out.set(volumeKey(ns, name), {
        usedBytes: used,
        capacityBytes: capacity,
        availableBytes: Number.isFinite(available) ? available : null,
        ...(shared ? { shared: true } : {})
      });
    }
  }
  return out;
}

export function dataVolumesOf(
  usage: Map<string, VolumeUsage>,
  namespace: string,
  clusterName: string
): VolumeUsage[] {
  const prefix = `${volumeKey(namespace, clusterName)}-`;
  const found: VolumeUsage[] = [];
  for (const [key, value] of usage) {
    if (!key.startsWith(prefix)) continue;
    if (!/^\d+$/.test(key.slice(prefix.length))) continue;
    found.push(value);
  }
  return found;
}

export function fullestVolume(volumes: VolumeUsage[]): VolumeUsage | null {
  let fullest: VolumeUsage | null = null;
  for (const v of volumes) {
    if (!fullest || v.usedBytes / v.capacityBytes > fullest.usedBytes / fullest.capacityBytes) {
      fullest = v;
    }
  }
  return fullest;
}

export function writeGuardDecision(
  guardOn: boolean,
  usedBytes: number,
  capacityBytes: number
): 'on' | 'off' | null {
  if (!(capacityBytes > 0) || usedBytes < 0) return null;
  const fraction = usedBytes / capacityBytes;
  if (!guardOn && fraction >= WRITE_GUARD_ENTER) return 'on';
  if (guardOn && fraction < WRITE_GUARD_EXIT) return 'off';
  return null;
}

const GI = 1024 ** 3;

function filesystemBytesAt(
  usage: { capacityBytes: number },
  storageSize: string,
  targetSize: string
): number | null {
  const current = parseMemory(storageSize);
  const target = parseMemory(targetSize);
  if (!(current > 0) || !(target > 0) || !(usage.capacityBytes > 0)) return null;
  return target * Math.min(1, usage.capacityBytes / current);
}

export function projectedFill(
  usage: { usedBytes: number; capacityBytes: number },
  storageSize: string,
  targetSize: string
): number | null {
  const capacity = filesystemBytesAt(usage, storageSize, targetSize);
  if (capacity == null || usage.usedBytes < 0) return null;
  return usage.usedBytes / capacity;
}

export function sizeToResumeWrites(
  usage: { usedBytes: number; capacityBytes: number },
  storageSize: string
): string | null {
  const perGi = filesystemBytesAt(usage, storageSize, '1Gi');
  if (perGi == null || usage.usedBytes < 0) return null;
  const gi = Math.floor(usage.usedBytes / WRITE_GUARD_EXIT / perGi) + 1;
  return gi * GI > parseMemory(storageSize) ? `${gi}Gi` : null;
}
