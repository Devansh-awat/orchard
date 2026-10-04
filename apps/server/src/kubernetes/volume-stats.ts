export const WRITE_GUARD_ENTER = 0.92;

export const WRITE_GUARD_EXIT = 0.85;

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
