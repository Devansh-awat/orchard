import * as k8s from '@kubernetes/client-node';

const ORCHARD_KEY_PREFIX = 'orchard/';

function foreignKeys(map: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map ?? {}).filter(([key]) => !key.startsWith(ORCHARD_KEY_PREFIX))
  );
}

export function cronJobForReplace(desired: k8s.V1CronJob, live: k8s.V1CronJob): k8s.V1CronJob {
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      labels: { ...foreignKeys(live.metadata?.labels), ...desired.metadata?.labels },
      annotations: {
        ...foreignKeys(live.metadata?.annotations),
        ...desired.metadata?.annotations
      },
      resourceVersion: live.metadata?.resourceVersion
    }
  };
}
