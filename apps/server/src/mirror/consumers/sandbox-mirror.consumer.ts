import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyQueueService } from '../../apply/apply-queue.service';
import {
  KubernetesSandboxRunner,
  forkSnapshotOf,
  sandboxCrKey,
  sandboxDestroyKey
} from '../../sandboxes/runners/kubernetes.runner';
import {
  CRD_API_VERSION,
  CRD_KIND,
  SANDBOX_ID_LABEL,
  SANDBOX_SHARD,
  readSandboxCr,
  sandboxStatusFromCr
} from '../../sandboxes/sandbox-cr';
import { applyObservation } from '../../sandboxes/runners/sandbox-status';
import { SANDBOX_REF_SELECT, refOf } from '../../sandboxes/runners/sandbox-runner';
import { MirrorEventType, MirrorObjectKey } from '../mirror-informer';

const DRIFT_STATUSES = ['creating', 'starting'] as const;

@Injectable()
export class SandboxMirrorConsumer {
  private readonly logger = new Logger(SandboxMirrorConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: KubernetesSandboxRunner,
    private readonly queue: ApplyQueueService
  ) {}

  async onEvent(type: MirrorEventType, cr: any): Promise<void> {
    const podName = cr?.metadata?.name;
    if (!podName) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { podName },
      select: { id: true, status: true, desiredState: true, runner: true, runnerState: true }
    });
    if (!row || row.runner !== 'kubernetes') return;
    if (type === 'delete') {
      await applyObservation(this.prisma, row, { exists: false, status: null, message: null });
      return;
    }
    const observed = readSandboxCr(cr);
    const status = sandboxStatusFromCr(observed);
    await applyObservation(this.prisma, row, {
      exists: true,
      status,
      message: observed.message
    });
    if (status === 'running' && forkSnapshotOf(row.runnerState)) {
      await this.requestForkCleanup(row.id);
    }
  }

  async onClaimEvent(type: MirrorEventType, claim: any): Promise<void> {
    if (type === 'delete' || claim?.status?.phase !== 'Bound') return;
    const sandboxId = claim?.metadata?.labels?.[SANDBOX_ID_LABEL];
    if (typeof sandboxId !== 'string' || !sandboxId) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { runner: true, status: true, runnerState: true }
    });
    if (!row || row.runner !== 'kubernetes' || row.status !== 'running') return;
    if (!forkSnapshotOf(row.runnerState)) return;
    await this.requestForkCleanup(sandboxId);
  }

  private async requestForkCleanup(sandboxId: string): Promise<void> {
    await this.runner
      .requestForkCleanup(sandboxId)
      .catch((e: any) =>
        this.logger.warn(`fork cleanup enqueue failed for ${sandboxId}: ${e?.message}`)
      );
  }

  async onListComplete(seen: MirrorObjectKey[]): Promise<void> {
    await this.sweepOrphans(seen);
    await this.reconcileDrift(seen);
  }

  async sweepOrphans(seen: MirrorObjectKey[]): Promise<void> {
    const names = seen.map((key) => key.name).filter(Boolean);
    if (names.length === 0) return;
    const known = await this.prisma.sandbox.findMany({
      where: { podName: { in: names } },
      select: { podName: true }
    });
    const claimed = new Set(known.map((r) => r.podName));
    for (const name of names) {
      if (claimed.has(name)) continue;
      this.logger.warn(`orphan sandbox resource ${name}; queueing its removal`);
      await this.runner
        .requestOrphanDestroy(name)
        .catch((e: any) => this.logger.warn(`orphan enqueue failed for ${name}: ${e?.message}`));
    }
  }

  async reconcileDrift(seen: MirrorObjectKey[]): Promise<void> {
    const present = new Set(seen.map((key) => key.name).filter(Boolean));
    const rows = await this.prisma.sandbox.findMany({
      where: { runner: 'kubernetes' },
      select: { ...SANDBOX_REF_SELECT, status: true, desiredState: true }
    });
    if (rows.length === 0) return;
    const manifests = present.size
      ? await this.prisma.k8sObject.findMany({
          where: {
            shard: SANDBOX_SHARD,
            kind: CRD_KIND,
            apiVersion: CRD_API_VERSION,
            name: { in: rows.map((r) => r.podName).filter((n) => present.has(n)) }
          },
          select: { name: true, manifest: true }
        })
      : [];
    const byName = new Map(manifests.map((m) => [m.name, readSandboxCr(m.manifest)]));
    for (const row of rows) {
      const cr = present.has(row.podName) ? byName.get(row.podName) : undefined;
      try {
        if (row.status === 'running' && forkSnapshotOf(row.runnerState)) {
          await this.requestForkCleanup(row.id);
        }
        if (row.desiredState === 'deleted') {
          if (await this.queue.hasOpenItem(sandboxDestroyKey(row.id))) continue;
          this.logger.warn(`sandbox ${row.id} is still waiting to be destroyed; queueing again`);
          await this.runner.requestDestroy(refOf(row));
          continue;
        }
        const wanted = row.desiredState === 'running' ? 'Running' : 'Suspended';
        const drifted = cr
          ? cr.operatingMode !== wanted
          : !present.has(row.podName) &&
            row.desiredState === 'running' &&
            (DRIFT_STATUSES as readonly string[]).includes(row.status);
        if (!drifted) continue;
        if (await this.queue.hasOpenItem(sandboxCrKey(row.id))) continue;
        this.logger.warn(
          `sandbox ${row.id} wants ${wanted} but the cluster has ${cr ? cr.operatingMode : 'nothing'}; queueing a reconcile`
        );
        if (!cr) await this.runner.requestSecretSync(refOf(row));
        await this.runner.enqueueCr(row.id);
      } catch (e: any) {
        this.logger.warn(`drift reconcile failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }
}
