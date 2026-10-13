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
