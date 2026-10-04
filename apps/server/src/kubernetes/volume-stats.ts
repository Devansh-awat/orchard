import { parseMemory } from './quantity';

export const AUTO_EXPAND_ENTER = 0.8;

export const AUTO_EXPAND_TARGET_FILL = 0.6;

export const AUTO_EXPAND_GROWTH = 1.3;

export const AUTO_EXPAND_MIN_STEP_GI = 2;

export const STORAGE_HARD_CAP = '200Gi';

const GI = 1024 ** 3;

export interface VolumeUsage {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number | null;
}

export function volumeKey(namespace: string, pvcName: string): string {
  return `${namespace}/${pvcName}`;
}

export function parseKubeletSummary(summary: unknown): Map<string, VolumeUsage> {
  const out = new Map<string, VolumeUsage>();
  const pods: any[] = Array.isArray((summary as any)?.pods) ? (summary as any).pods : [];
  for (const pod of pods) {
    const volumes: any[] = Array.isArray(pod?.volume) ? pod.volume : [];
    for (const vol of volumes) {
      const ns = vol?.pvcRef?.namespace;
      const name = vol?.pvcRef?.name;
      const used = Number(vol?.usedBytes);
      const capacity = Number(vol?.capacityBytes);
      if (!ns || !name || !Number.isFinite(used) || !(capacity > 0)) continue;
      const available = Number(vol?.availableBytes);
      out.set(volumeKey(ns, name), {
        usedBytes: used,
        capacityBytes: capacity,
        availableBytes: Number.isFinite(available) ? available : null
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

export function nextStorageSize(
  specSize: string | null | undefined,
  usedBytes: number,
  capacityBytes: number
): string | null {
  if (!(capacityBytes > 0) || usedBytes < 0) return null;
  if (usedBytes / capacityBytes < AUTO_EXPAND_ENTER) return null;
  const specBytes = specSize ? parseMemory(specSize) : 0;
  if (specBytes > capacityBytes * 1.05) return null;
  const wanted = Math.max(capacityBytes * AUTO_EXPAND_GROWTH, usedBytes / AUTO_EXPAND_TARGET_FILL);
  const currentGi = Math.ceil(Math.max(specBytes, capacityBytes) / GI);
  const targetGi = Math.max(Math.ceil(wanted / GI), currentGi + AUTO_EXPAND_MIN_STEP_GI);
  const capGi = Math.floor(parseMemory(STORAGE_HARD_CAP) / GI);
  const finalGi = Math.min(targetGi, capGi);
  if (finalGi <= currentGi) return null;
  return `${finalGi}Gi`;
}
