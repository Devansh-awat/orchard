import { ForbiddenException, NotFoundException } from '@nestjs/common';

export const POD_EXEC_DENIED_MESSAGE =
  'database and platform pods are not accessible by exec; use the database connection string / psql from your app or `orchard db` instead';

const MANAGED_BY = 'app.kubernetes.io/managed-by';
const APP_NAME = 'app.kubernetes.io/name';

const PLATFORM_LABEL_KEYS = ['orchard.my/tailscale', 'orchard/job-id', 'orchard/run-id'];

export type PodLabels = Record<string, string> | null | undefined;

export function isExecableAppPod(labels: PodLabels): boolean {
  if (!labels) return false;
  if (labels[MANAGED_BY] !== 'orchard') return false;
  const name = labels[APP_NAME];
  if (!name) return false;
  for (const key of Object.keys(labels)) {
    if (key.startsWith('cnpg.io/')) return false;
  }
  for (const key of PLATFORM_LABEL_KEYS) {
    if (key in labels) return false;
  }
  if (name.includes('pgbouncer') || name.includes('pooler')) return false;
  return true;
}

export type PodLabelReader = (namespace: string, podName: string) => Promise<PodLabels>;

export async function checkPodExecable(
  read: PodLabelReader,
  namespace: string,
  podName: string
): Promise<'ok' | 'denied' | 'missing'> {
  let labels: PodLabels;
  try {
    labels = await read(namespace, podName);
  } catch {
    return 'missing';
  }
  return isExecableAppPod(labels) ? 'ok' : 'denied';
}

export async function assertPodExecable(
  read: PodLabelReader,
  namespace: string,
  podName: string
): Promise<void> {
  const verdict = await checkPodExecable(read, namespace, podName);
  if (verdict === 'missing') throw new NotFoundException(`Pod ${podName} not found`);
  if (verdict === 'denied') throw new ForbiddenException(POD_EXEC_DENIED_MESSAGE);
}
