import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type { KubernetesObject } from '@kubernetes/client-node';
import { ApplyExecutorService, type ApplyHandler } from '../../apply/apply-executor.service';
import { ApplyQueueService, type EnqueueInput } from '../../apply/apply-queue.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class ApplyDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'apply',
    version: 1,
    status: 'stable',
    capability: 'kube.apply'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ApplyQueueService) private readonly queue: ApplyQueueService,
    @Inject(ApplyExecutorService) private readonly executor: ApplyExecutorService
  ) {
    this.graft = bindGraft(parent, ApplyDoorV1.meta);
  }

  registerHandler(opType: string, handler: ApplyHandler): void {
    assertClaimed(this.graft, 'applyOps', opType, 'apply op');
    this.executor.registerHandler(opType, handler);
  }

  enqueue(input: EnqueueInput): Promise<void> {
    assertClaimed(this.graft, 'applyOps', input.opType, 'apply op');
    return this.queue.enqueue(input);
  }

  hasOpenItem(dedupeKey: string): Promise<boolean> {
    return this.queue.hasOpenItem(dedupeKey);
  }

  retryForSubject(subjectId: string): Promise<number> {
    return this.queue.retryForSubject(subjectId);
  }

  serverSideApply(manifest: KubernetesObject): Promise<KubernetesObject> {
    return this.executor.ssaApply(manifest);
  }
}
