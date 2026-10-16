import type * as k8s from '@kubernetes/client-node';

export function isExternalDeployment(dep: k8s.V1Deployment): boolean {
  const meta = dep.metadata;
  if (!meta?.name) return false;
  if (meta.labels?.['app.kubernetes.io/managed-by'] === 'orchard') return false;
  return (meta.ownerReferences ?? []).length === 0;
}
