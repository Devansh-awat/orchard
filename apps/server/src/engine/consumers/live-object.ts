import * as k8s from '@kubernetes/client-node';
import { Logger } from '@nestjs/common';
import { KubernetesService } from '../../kubernetes/kubernetes.service';

export type LiveState = 'present' | 'absent' | 'unknown';

export async function readLive(
  kubernetes: KubernetesService,
  logger: Logger,
  read: (kc: k8s.KubeConfig) => Promise<unknown>
): Promise<LiveState> {
  try {
    kubernetes.ensureKubeConfig();
    await read(kubernetes.kc!);
    return 'present';
  } catch (err: any) {
    const code = err?.response?.statusCode ?? err?.statusCode;
    if (code === 404) return 'absent';
    logger.warn(
      `could not read from the apiserver (${code ?? 'no status'}): ${err?.message ?? err}`
    );
    return 'unknown';
  }
}
