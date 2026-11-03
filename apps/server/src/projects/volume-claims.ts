export interface VolumeHolder {
  name: string;
  pvcName: string | null;
  deployment: { id: string; name: string };
}

export function volumeClaim(vol: { name?: string | null; pvcName?: string | null }): string {
  return vol.pvcName?.trim() || vol.name?.trim() || '';
}

export function findVolumeConflict(
  wanted: readonly string[],
  holders: readonly VolumeHolder[],
  exceptDeploymentIds: readonly string[] = []
): { claim: string; holder: string } | null {
  for (const holder of holders) {
    const claim = volumeClaim(holder);
    if (!wanted.includes(claim)) continue;
    if (exceptDeploymentIds.includes(holder.deployment.id)) continue;
    return { claim, holder: holder.deployment.name };
  }
  return null;
}
