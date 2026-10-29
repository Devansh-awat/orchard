import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VictoriaMetricsService, escapeLabel } from '../metrics/victoria-metrics.service';
import type { ClusterSnapshot } from '../kubernetes/cnpg-status';
import { databaseHealth, type DatabaseHealth, type HealthLine } from './database-health';

export interface Dependency {
  kind: 'database' | 'deployment';
  id: string;
  name: string;
  binding: string;
  status: DatabaseHealth['status'];
  lines: HealthLine[];
  restarts: { t: number; pod: string }[];
}

const RESTART_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function appHealth(app: { status: string; stopped: boolean }): {
  status: Dependency['status'];
  lines: HealthLine[];
} {
  if (app.stopped) return { status: 'stopped', lines: [{ tone: 'neutral', text: 'Stopped' }] };
  const s = app.status.toLowerCase();
  if (s === 'crashing' || s === 'failed' || s === 'error') {
    return { status: 'error', lines: [{ tone: 'error', text: 'Crashing' }] };
  }
  if (s === 'degraded' || s === 'unhealthy' || s === 'pending') {
    return { status: 'warning', lines: [{ tone: 'warning', text: 'Not fully ready' }] };
  }
  return { status: 'healthy', lines: [] };
}

@Injectable()
export class DependenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vm: VictoriaMetricsService
  ) {}

  async list(deploymentId: string): Promise<{ dependencies: Dependency[] }> {
    const bindings = await this.prisma.resourceBinding.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' }
    });
    const out: Dependency[] = [];
    const since = new Date(Date.now() - RESTART_LOOKBACK_MS);
    for (const b of bindings) {
      if (b.resourceType === 'database') {
        const db = await this.prisma.database.findUnique({
          where: { id: b.resourceId },
          select: {
            id: true,
            name: true,
            status: true,
            namespace: true,
            clusterName: true,
            replicas: true,
            clusterStatus: true,
            volumeUsedBytes: true,
            volumeCapacityBytes: true,
            walPendingSegments: true,
            connections: true,
            pgParameters: true,
            backupScheduleDisabled: true,
            pods: {
              where: { lastTerminatedAt: { gte: since } },
              select: { name: true, lastTerminatedAt: true }
            }
          }
        });
        if (!db) continue;
        const snapshot = db.clusterStatus as unknown as ClusterSnapshot | null;
        const lag =
          db.replicas > 1 && db.namespace && db.clusterName
            ? await this.vm
                .queryInstant(
                  `max(cnpg_pg_replication_lag{namespace="${escapeLabel(db.namespace)}",cluster="${escapeLabel(db.clusterName)}"})`
                )
                .catch(() => null)
            : null;
        const params = (db.pgParameters ?? {}) as Record<string, string>;
        const health = databaseHealth({
          status: db.status,
          hibernated: !!snapshot?.hibernated,
          instances: snapshot?.instances ?? db.replicas,
          readyInstances: snapshot?.readyInstances ?? 0,
          lastSuccessfulBackup: snapshot?.lastSuccessfulBackup ?? null,
          backupsOff: db.backupScheduleDisabled,
          volumeUsedBytes: db.volumeUsedBytes != null ? Number(db.volumeUsedBytes) : null,
          volumeCapacityBytes:
            db.volumeCapacityBytes != null ? Number(db.volumeCapacityBytes) : null,
          walPendingSegments: db.walPendingSegments,
          connections: db.connections,
          maxConnections: Number(params.max_connections) || 100,
          replicationLagSeconds: lag,
          now: Date.now()
        });
        out.push({
          kind: 'database',
          id: db.id,
          name: db.name,
          binding: b.name,
          ...health,
          restarts: db.pods.flatMap((p) =>
            p.lastTerminatedAt ? [{ t: p.lastTerminatedAt.getTime(), pod: p.name }] : []
          )
        });
      } else if (b.resourceType === 'deployment') {
        const app = await this.prisma.deployment.findUnique({
          where: { id: b.resourceId },
          select: { id: true, name: true, displayName: true, status: true, stopped: true }
        });
        if (!app) continue;
        out.push({
          kind: 'deployment',
          id: app.id,
          name: app.displayName || app.name,
          binding: b.name,
          ...appHealth(app),
          restarts: []
        });
      }
    }
    return { dependencies: out };
  }
}
