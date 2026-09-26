/**
 * Pod-name matcher for a Deployment's own pods, and nothing else.
 *
 * A Deployment names its pods `<deployment>-<replicaset hash>-<pod hash>`, so
 * the two trailing segments are what tell `crescent` apart from `crescent-ssr`
 * and `crescent-worker`. Matching `<name>-.*` sweeps all three into one series:
 * the `crescent` app was charged for the CPU of every sibling deployment whose
 * name it happened to prefix, against a budget sized for its own single pod.
 *
 * Deliberately not used for CNPG databases, whose pods are `<cluster>-1` and
 * carry no ReplicaSet hash at all.
 */
export function deploymentPodRegex(name: string): string {
  const base = escapePromRegex(name);
  return `(?:${base}|${base}--green)-[a-z0-9]+-[a-z0-9]+`;
}

export function escapePromRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
