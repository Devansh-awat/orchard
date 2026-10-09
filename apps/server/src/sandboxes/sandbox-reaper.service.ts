import { Injectable, Logger } from '@nestjs/common';
import { Sandbox } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxProbesService } from './runners/sandbox-probes.service';
import {
  SANDBOX_REF_SELECT,
  SandboxRunner,
  SandboxRunnerId,
  forkSourceOf,
  refOf
} from './runners/sandbox-runner';
import { applyObservation } from './runners/sandbox-status';

const STUCK_TRANSITION_MS = 10 * 60 * 1000;
export const FORK_TRANSITION_MS = 30 * 60 * 1000;

export function transitionWindowMs(runnerState: unknown): number {
  return forkSourceOf(runnerState) ? FORK_TRANSITION_MS : STUCK_TRANSITION_MS;
}

export function idleTimeoutMs(): number {
  const minutes = Number(process.env.SANDBOX_IDLE_TIMEOUT_MINUTES);
  const resolved = Number.isFinite(minutes) ? minutes : 60;
  return resolved > 0 ? resolved * 60 * 1000 : 0;
}

export function maxLifetimeMs(): number {
  const hours = Number(process.env.SANDBOX_MAX_LIFETIME_HOURS);
  const resolved = Number.isFinite(hours) ? hours : 168;
  return resolved > 0 ? resolved * 60 * 60 * 1000 : 0;
}

@Injectable()
export class SandboxReaperService {
  private readonly logger = new Logger(SandboxReaperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly probes: SandboxProbesService
  ) {}

  async tick(): Promise<void> {
    try {
      await this.syncPolledRunners();
      await this.syncWithoutMirror();
      await this.failStuckTransitions();
      await this.reapIdle();
      await this.enforceMaxLifetime();
    } catch (e: any) {
      this.logger.warn(`reaper tick failed: ${e?.message}`);
    }
  }

  private runnerFor(row: Sandbox): SandboxRunner | null {
    try {
      return this.registry.for(row);
    } catch {
      return null;
    }
  }

  async syncPolledRunners(): Promise<void> {
    for (const runner of this.registry.all()) {
      if (runner.capabilities.statusSource !== 'poll' || !runner.reconcile) continue;
      if (runner.configError()) continue;
      try {
        const rows = await this.prisma.sandbox.findMany({
          where: {
            runner: runner.id,
            desiredState: { not: 'deleted' },
            status: { in: ['creating', 'starting', 'running', 'stopping'] }
          },
          select: { ...SANDBOX_REF_SELECT, status: true }
        });
        if (rows.length === 0) continue;
        await runner.reconcile(rows.map(refOf));
        if (!runner.keepAlive) continue;
        for (const row of rows) {
          if (row.status !== 'running') continue;
          await runner
            .keepAlive(refOf(row))
            .catch((e: any) =>
              this.logger.warn(`keep-alive failed for sandbox ${row.id}: ${e?.message}`)
            );
        }
      } catch (e: any) {
        this.logger.warn(`${runner.id} status poll failed: ${e?.message}`);
      }
    }
  }

  private async syncWithoutMirror(): Promise<void> {
    if (process.env.MIRROR_DISABLED !== 'true') return;
    const rows = await this.prisma.sandbox.findMany({
      where: {
        runner: 'kubernetes',
        status: { in: ['creating', 'starting', 'running', 'stopping'] }
      }
    });
    for (const row of rows) {
      const runner = this.runnerFor(row);
      if (!runner) continue;
      try {
        await applyObservation(this.prisma, row, await runner.observe(refOf(row)));
      } catch (e: any) {
        this.logger.warn(`status sync failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  private async failStuckTransitions(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_TRANSITION_MS);
    const rows = await this.prisma.sandbox.findMany({
      where: { status: { in: ['creating', 'starting'] }, updatedAt: { lt: cutoff } }
    });
    if (rows.length === 0) return;
    const trust = new Map<SandboxRunnerId, boolean>();
    const now = Date.now();
    for (const row of rows) {
      if (row.updatedAt.getTime() > now - transitionWindowMs(row.runnerState)) continue;
      const runner = this.runnerFor(row);
      if (!runner) continue;
      if (!trust.has(runner.id)) {
        trust.set(runner.id, await runner.canTrustAbsence().catch(() => false));
      }
      if (!trust.get(runner.id)) {
        this.logger.warn(`sandbox ${row.id} is mid-transition but ${runner.id} is not reporting`);
        continue;
      }
      try {
        const observed = await runner.observe(refOf(row));
        await this.prisma.sandbox.updateMany({
          where: { id: row.id, status: row.status },
          data: {
            status: 'error',
            statusMessage: observed.exists
              ? observed.message || 'Sandbox did not become ready in time'
              : 'Sandbox resource never appeared in the cluster'
          }
        });
      } catch (e: any) {
        this.logger.warn(`stuck check failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  private async stopFor(
    row: Sandbox,
    action: 'sandbox.idle_stop' | 'sandbox.lifetime_stop',
    statusMessage: string | undefined,
    metadata: Record<string, number>
  ): Promise<void> {
    const runner = this.runnerFor(row);
    if (!runner) return;
    const { count } = await this.prisma.sandbox.updateMany({
      where: { id: row.id, status: 'running', desiredState: 'running' },
      data: {
        desiredState: 'stopped',
        status: 'stopping',
        startedAt: null,
        ...(statusMessage ? { statusMessage } : {})
      }
    });
    if (count === 0) return;
    await runner.requestStop(refOf(row));
    this.audit
      .log({
        action,
        actorUserId: null,
        targetType: 'sandbox',
        targetId: row.id,
        targetLabel: row.name,
        metadata
      })
      .catch(() => {});
  }

  private async reapIdle(): Promise<void> {
    const timeout = idleTimeoutMs();
    if (!timeout) return;
    const cutoff = new Date(Date.now() - timeout);
    const idle = await this.prisma.sandbox.findMany({
      where: { status: 'running', desiredState: 'running', lastActiveAt: { lt: cutoff } }
    });
    for (const row of idle) {
      try {
        if (await this.probes.isAgentBusy(row)) {
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { lastActiveAt: new Date() }
          });
          continue;
        }
        await this.stopFor(row, 'sandbox.idle_stop', undefined, {
          idleMinutes: Math.round(timeout / 60000)
        });
      } catch (e: any) {
        this.logger.warn(`idle reap failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  private async enforceMaxLifetime(): Promise<void> {
    const lifetime = maxLifetimeMs();
    if (!lifetime) return;
    const cutoff = new Date(Date.now() - lifetime);
    const expired = await this.prisma.sandbox.findMany({
      where: { status: 'running', desiredState: 'running', startedAt: { lt: cutoff } }
    });
    for (const row of expired) {
      try {
        await this.stopFor(row, 'sandbox.lifetime_stop', 'Stopped after reaching max lifetime', {
          lifetimeHours: Math.round(lifetime / 3600000)
        });
      } catch (e: any) {
        this.logger.warn(`lifetime stop failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }
}
