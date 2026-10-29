import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { SCAN_LABEL, scanJobFailure } from '../../security/trivy-job';
import { EngineEventType, EngineRefs } from '../core/informer';
import { readLive } from './live-object';

@Injectable()
export class ScanJobConsumer {
  private readonly logger = new Logger(ScanJobConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService
  ) {}

  async mapRefs(): Promise<EngineRefs> {
    return {};
  }

  async onEvent(type: EngineEventType, job: k8s.V1Job): Promise<void> {
    const scanId = job.metadata?.labels?.[SCAN_LABEL];
    const namespace = job.metadata?.namespace;
    const name = job.metadata?.name;
    if (!scanId || !namespace || !name) return;

    let error: string | null;
    if (type === 'delete') {
      const state = await readLive(this.kubernetes, this.logger, (kc) =>
        kc.makeApiClient(k8s.BatchV1Api).readNamespacedJob(name, namespace)
      );
      if (state === 'present') return;
      if (state === 'unknown') {
        throw new Error(
          `scan job ${namespace}/${name} looks deleted but the apiserver could not confirm it`
        );
      }
      error = 'The scan job was removed before it reported a result';
    } else {
      error = scanJobFailure(job);
    }
    if (!error) return;

    await this.prisma.imageScan.updateMany({
      where: { id: scanId, status: 'running' },
      data: { status: 'failed', tokenHash: null, error, finishedAt: new Date() }
    });
  }
}
