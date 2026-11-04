import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ReleaseStatus = 'live' | 'superseded' | 'failed' | 'rolled_back';

export interface RecordReleaseInput {
  image: string;
  imageHistoryId?: string | null;
  strategy: 'rollingUpdate' | 'recreate' | 'blueGreen';
  status: 'live' | 'failed';
  reason?: string | null;
  createdById?: string | null;
}

const LIST_MAX = 100;

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(deploymentId: string, input: RecordReleaseInput) {
    const snapshot = await this.snapshot(deploymentId);
    if (!snapshot) return null;
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.status === 'live') {
          await tx.release.updateMany({
            where: { deploymentId, status: 'live' },
            data: { status: 'superseded', supersededAt: now }
          });
        }
        return tx.release.create({
          data: {
            deploymentId,
            imageHistoryId: input.imageHistoryId ?? null,
            image: input.image,
            strategy: input.strategy,
            status: input.status,
            reason: input.reason ?? null,
            envSnapshot: snapshot.env as Prisma.InputJsonValue,
            resourceSnapshot: snapshot.resources as Prisma.InputJsonValue,
            healthCheckSnapshot: snapshot.healthCheck as Prisma.InputJsonValue,
            startCommand: snapshot.startCommand,
            replicas: snapshot.replicas,
            createdById: input.createdById ?? null,
            promotedAt: input.status === 'live' ? now : null
          }
        });
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record release for ${deploymentId}: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  async markRolledBack(deploymentId: string, reason: string) {
    await this.prisma.release
      .updateMany({
        where: { deploymentId, status: 'live' },
        data: { status: 'rolled_back', supersededAt: new Date(), reason }
      })
      .catch(() => {});
  }

  async list(deploymentId: string, limit = 20, canEdit = true) {
    const take = Math.min(Math.max(limit, 1), LIST_MAX);
    const rows = await this.prisma.release.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        createdBy: { select: { id: true, username: true, imageUrl: true } },
        imageHistory: {
          select: { id: true, commitSha: true, commitMessage: true, branch: true, tag: true }
        }
      }
    });
    return rows.map((r) => ({
      ...r,
      resourceSnapshot: r.resourceSnapshot,
      ...(canEdit ? {} : { envSnapshot: null, startCommand: null, healthCheckSnapshot: null })
    }));
  }

  private async snapshot(deploymentId: string) {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        replicas: true,
        startCommand: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        nodePoolId: true,
        placementOverride: true,
        healthCheckEnabled: true,
        healthCheckType: true,
        healthCheckPath: true,
        healthCheckPort: true,
        healthCheckCommand: true,
        livenessEnabled: true,
        readinessEnabled: true,
        startupEnabled: true,
        healthCheckInterval: true,
        healthCheckTimeout: true,
        healthCheckRetries: true,
        startupFailureThreshold: true,
        healthCheckOverride: true,
        envVars: { select: { key: true, value: true, secret: true }, orderBy: { key: 'asc' } }
      }
    });
    if (!row) return null;
    return {
      replicas: row.replicas,
      startCommand: row.startCommand,
      env: row.envVars.map((v) =>
        v.secret ? { key: v.key, secret: true } : { key: v.key, value: v.value }
      ),
      resources: {
        cpuRequestMilli: row.cpuRequestMilli,
        memoryRequestBytes: row.memoryRequestBytes === null ? null : Number(row.memoryRequestBytes),
        nodePoolId: row.nodePoolId,
        placementOverride: row.placementOverride
      },
      healthCheck: {
        enabled: row.healthCheckEnabled,
        type: row.healthCheckType,
        path: row.healthCheckPath,
        port: row.healthCheckPort,
        command: row.healthCheckCommand,
        livenessEnabled: row.livenessEnabled,
        readinessEnabled: row.readinessEnabled,
        startupEnabled: row.startupEnabled,
        interval: row.healthCheckInterval,
        timeout: row.healthCheckTimeout,
        retries: row.healthCheckRetries,
        startupFailureThreshold: row.startupFailureThreshold,
        override: row.healthCheckOverride
      }
    };
  }
}
