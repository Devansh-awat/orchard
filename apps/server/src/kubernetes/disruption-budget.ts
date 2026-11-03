import * as k8s from '@kubernetes/client-node';

/**
 * A PodDisruptionBudget only ever helps when the app has a pod to spare.
 * `minAvailable` equal to (or above) the replica count leaves zero allowed
 * disruptions, so the eviction API refuses every request and a node drain
 * hangs on the app forever instead of moving it. The chart's own PDBs are
 * gated the same way.
 *
 * 0 is the user turning the budget off outright.
 */
export function disruptionBudgetActive(minAvailable: number, replicas: number): boolean {
  return normalizeMinAvailable(minAvailable) > 0 && replicas > normalizeMinAvailable(minAvailable);
}

export function normalizeMinAvailable(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * `spec.minAvailable` is an IntOrString, so a budget written by hand can carry
 * "50%", a shape Orchard's integer column cannot hold. Returns null for
 * anything that is not a plain whole number, and callers leave the stored
 * setting alone rather than guessing at it.
 */
export function readMinAvailable(spec: k8s.V1PodDisruptionBudgetSpec | undefined): number | null {
  const raw = spec?.minAvailable as number | string | undefined;
  if (raw == null) return null;
  if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function disruptionBudgetManifest(options: {
  name: string;
  namespace: string;
  minAvailable: number;
}): k8s.V1PodDisruptionBudget {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: options.name,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/name': options.name,
        // The mirror informer watches on this selector, so a budget without it
        // is invisible to Orchard.
        'app.kubernetes.io/managed-by': 'orchard'
      }
    },
    spec: {
      minAvailable: options.minAvailable,
      selector: { matchLabels: { 'app.kubernetes.io/name': options.name } },
      // A pod that is running but has never gone ready isn't part of what the
      // budget protects, so let the drain take it. Without this a single
      // crash-looping replica makes the whole node undrainable.
      unhealthyPodEvictionPolicy: 'AlwaysAllow'
    }
  };
}
