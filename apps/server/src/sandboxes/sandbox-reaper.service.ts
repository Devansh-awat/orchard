import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SandboxK8sService } from './sandbox-k8s.service';

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
    private readonly k8s: SandboxK8sService,
  ) {}

  async tick(): Promise<void> {
    try {
      await this.syncStatuses();
      await this.reapIdle();
      await this.enforceMaxLifetime();
    } catch (e: any) {
      this.logger.warn(`reaper tick failed: ${e?.message}`);
    }
  }

  private async syncStatuses(): Promise<void> {
    const rows = await this.prisma.sandbox.findMany({
      where: { status: { in: ['creating', 'starting', 'running', 'stopping'] } },
    });
    const crNames = new Set(await this.k8s.listCrNames());
    for (const row of rows) {
      try {
        if (!crNames.has(row.podName)) {
          if (row.status === 'creating') continue;
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { status: 'error', statusMessage: 'Sandbox resource disappeared from the cluster' },
          });
          continue;
        }
        const cr = await this.k8s.getCrStatus(row.podName);
        if (cr.operatingMode === 'Suspended') {
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { status: 'stopped', statusMessage: null },
          });
        } else if (cr.ready) {
          if (row.status === 'running') continue;
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { status: 'running', statusMessage: null },
          });
        } else if (
          (row.status === 'creating' || row.status === 'starting') &&
          Date.now() - row.updatedAt.getTime() > STUCK_TRANSITION_MS
        ) {
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: {
              status: 'error',
              statusMessage: cr.message || 'Sandbox did not become ready in time',
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`status sync failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
    await this.deleteOrphans(crNames);
  }

  private async deleteOrphans(crNames: Set<string>): Promise<void> {
    if (!crNames.size) return;
    const known = await this.prisma.sandbox.findMany({
      where: { podName: { in: [...crNames] } },
      select: { podName: true },
    });
    const knownNames = new Set(known.map((r) => r.podName));
    for (const name of crNames) {
      if (knownNames.has(name)) continue;
      this.logger.warn(`deleting orphan sandbox resource ${name}`);
      const idMatch = name.match(/^sbx-(.+)$/);
      await this.k8s
        .deleteSandbox({ id: idMatch ? idMatch[1] : name, podName: name })
        .catch((e: any) => this.logger.warn(`orphan delete failed for ${name}: ${e?.message}`));
    }
  }

  private async reapIdle(): Promise<void> {
    const timeout = idleTimeoutMs();
    if (!timeout) return;
    const cutoff = new Date(Date.now() - timeout);
    const idle = await this.prisma.sandbox.findMany({
      where: { status: 'running', lastActiveAt: { lt: cutoff } },
    });
    for (const row of idle) {
      try {
        if (await this.k8s.isAgentBusy(row.id)) {
          await this.prisma.sandbox.update({
            where: { id: row.id },
            data: { lastActiveAt: new Date() },
          });
          continue;
        }
        await this.k8s.suspend(row.podName);
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: { status: 'stopping' },
        });
        this.audit
          .log({
            action: 'sandbox.idle_stop',
            actorUserId: null,
            targetType: 'sandbox',
            targetId: row.id,
            targetLabel: row.name,
            metadata: { idleMinutes: Math.round(timeout / 60000) },
          })
          .catch(() => {});
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
      where: { status: 'running', createdAt: { lt: cutoff } },
    });
    for (const row of expired) {
      try {
        await this.k8s.suspend(row.podName);
        await this.prisma.sandbox.update({
          where: { id: row.id },
          data: { status: 'stopping', statusMessage: 'Stopped after reaching max lifetime' },
        });
      } catch (e: any) {
        this.logger.warn(`lifetime stop failed for sandbox ${row.id}: ${e?.message}`);
      }
    }
  }
}
