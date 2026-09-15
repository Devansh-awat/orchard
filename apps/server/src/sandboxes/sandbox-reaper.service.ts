import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SandboxK8sService } from './sandbox-k8s.service';
import { sandboxStatusFromCr } from './sandbox-cr';

const STUCK_TRANSITION_MS = 10 * 60 * 1000;

function idleTimeoutMs(): number {
  const minutes = Number(process.env.SANDBOX_IDLE_TIMEOUT_MINUTES);
  const resolved = Number.isFinite(minutes) ? minutes : 60;
  return resolved > 0 ? resolved * 60 * 1000 : 0;
}

function maxLifetimeMs(): number {
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
    private readonly k8s: SandboxK8sService
  ) {}

  async tick(): Promise<void> {
    try {
      await this.syncWithoutMirror();
      await this.failStuckTransitions();
      await this.reapIdle();
      await this.enforceMaxLifetime();
    } catch (e: any) {
      this.logger.warn(`reaper tick failed: ${e?.message}`);
    }
  }

  /**
   * The poll the mirror replaced, kept for installs running with
   * MIRROR_DISABLED=true. getCrStatus reads straight from the cluster there, so
   * this is the same derivation the informer consumer applies, on a timer
   * instead of on an event.
   */
  private async syncWithoutMirror(): Promise<void> {
    if (process.env.MIRROR_DISABLED !== 'true') return;
    const rows = await this.prisma.sandbox.findMany({
      where: { status: { in: ['creating', 'starting', 'running', 'stopping'] } }
    });
    for (const row of rows) {
      try {
        const cr = await this.k8s.getCrStatus(row.podName);
        if (!cr.exists) {
          if (row.status === 'creating') continue;
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: {
              status: 'error',
              statusMessage: 'Sandbox resource disappeared from the cluster'
            }
          });
          continue;
        }
        const status = sandboxStatusFromCr(cr);
        if (!status || status === row.status) continue;
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: { status, statusMessage: null }
        });
      } catch (e: any) {
        this.logger.warn(`status sync failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  /**
   * Sandbox status is derived from the mirror as the resource moves, so the
   * only thing still needing a clock is a transition that produces no further
   * events: a sandbox whose resource was never created, or was created and
   * never went ready, has nothing left to report.
   *
   * Gated on a healthy shard. A mirror that is not running is not evidence that
   * a sandbox failed to start, and reading it as such is how an install with
   * its informers down marks every running box broken.
   */
  private async failStuckTransitions(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_TRANSITION_MS);
    const rows = await this.prisma.sandbox.findMany({
      where: { status: { in: ['creating', 'starting'] }, updatedAt: { lt: cutoff } }
    });
    if (rows.length === 0) return;
    if (!(await this.k8s.canTrustCrAbsence())) {
      this.logger.warn(`${rows.length} sandbox(es) mid-transition but the mirror is not current`);
      return;
    }
    for (const row of rows) {
      try {
        const cr = await this.k8s.getCrStatus(row.podName);
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: {
            status: 'error',
            statusMessage: cr.exists
              ? cr.message || 'Sandbox did not become ready in time'
              : 'Sandbox resource never appeared in the cluster'
          }
        });
      } catch (e: any) {
        this.logger.warn(`stuck check failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  private async reapIdle(): Promise<void> {
    const timeout = idleTimeoutMs();
    if (!timeout) return;
    const cutoff = new Date(Date.now() - timeout);
    const idle = await this.prisma.sandbox.findMany({
      where: { status: 'running', lastActiveAt: { lt: cutoff } }
    });
    for (const row of idle) {
      try {
        if (await this.k8s.isAgentBusy(row.id)) {
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { lastActiveAt: new Date() }
          });
          continue;
        }
        const existed = await this.k8s.suspend(row.podName);
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: { status: existed ? 'stopping' : 'stopped', startedAt: null }
        });
        this.audit
          .log({
            action: 'sandbox.idle_stop',
            actorUserId: null,
            targetType: 'sandbox',
            targetId: row.id,
            targetLabel: row.name,
            metadata: { idleMinutes: Math.round(timeout / 60000) }
          })
          .catch(() => {});
      } catch (e: any) {
        this.logger.warn(`idle reap failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }

  /**
   * Cap how long a single run may last. Measured from startedAt, the beginning
   * of the current run, not from when the row was first created: a sandbox is a
   * durable thing a user starts and stops for weeks, and reading its age as its
   * uptime means every box older than the cap gets suspended seconds after it
   * goes ready, forever, with no way for the user to tell why.
   *
   * startedAt is null for a box that has not run since this was introduced, and
   * a run whose start we cannot place is not a run we can call expired.
   */
  private async enforceMaxLifetime(): Promise<void> {
    const lifetime = maxLifetimeMs();
    if (!lifetime) return;
    const cutoff = new Date(Date.now() - lifetime);
    const expired = await this.prisma.sandbox.findMany({
      where: { status: 'running', startedAt: { lt: cutoff } }
    });
    for (const row of expired) {
      try {
        const existed = await this.k8s.suspend(row.podName);
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: {
            status: existed ? 'stopping' : 'stopped',
            statusMessage: 'Stopped after reaching max lifetime',
            startedAt: null
          }
        });
        this.audit
          .log({
            action: 'sandbox.lifetime_stop',
            actorUserId: null,
            targetType: 'sandbox',
            targetId: row.id,
            targetLabel: row.name,
            metadata: { lifetimeHours: Math.round(lifetime / 3600000) }
          })
          .catch(() => {});
      } catch (e: any) {
        this.logger.warn(`lifetime stop failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }
}
