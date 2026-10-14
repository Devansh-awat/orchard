import { Inject, Injectable } from '@nestjs/common';
import { Doors, type ApplyDoor, type ApplyItem } from '@orchardlabs/graft-sdk/server';

export type ApplyItemInput = ApplyItem;

export type ApplyHandler = (item: ApplyItemInput) => Promise<void>;

export const SANDBOX_OP_SSA = 'sandbox.ssa';

export interface EnqueueInput {
  dedupeKey: string;
  opType: string;
  manifest?: unknown;
  deploymentId?: string;
  sandboxId?: string;
  requestedById?: string;
}

@Injectable()
export class ApplyQueueService {
  constructor(@Inject(Doors.apply) private readonly apply: ApplyDoor) {}

  async enqueue(input: EnqueueInput): Promise<void> {
    const { sandboxId, opType, ...rest } = input;
    await this.apply.enqueue({
      ...rest,
      opType: opType === 'ssa' ? SANDBOX_OP_SSA : opType,
      ...(sandboxId ? { subjectId: sandboxId } : {})
    });
  }

  hasOpenItem(dedupeKey: string): Promise<boolean> {
    return this.apply.hasOpenItem(dedupeKey);
  }

  retryForSandbox(sandboxId: string): Promise<number> {
    return this.apply.retryForSubject(sandboxId);
  }
}

@Injectable()
export class ApplyExecutorService {
  constructor(@Inject(Doors.apply) private readonly apply: ApplyDoor) {
    this.apply.registerHandler(SANDBOX_OP_SSA, async (item) => {
      await this.apply.serverSideApply(item.manifest as { apiVersion?: string; kind?: string });
    });
  }

  registerHandler(opType: string, handler: ApplyHandler): void {
    this.apply.registerHandler(opType, handler);
  }

  ssaApply<T extends { apiVersion?: string; kind?: string }>(manifest: T): Promise<T> {
    return this.apply.serverSideApply(manifest);
  }
}
