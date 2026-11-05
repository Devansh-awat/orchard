import { splitRegistryCleanup } from './image-ownership';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { DockerService } from '../docker/docker.service';
import { StorageService } from '../organizations/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { R2ProxyService } from '../kubernetes/r2-proxy.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { AuditService } from '../audit/audit.service';
import type { DatabasesService as DatabasesServiceType } from './databases.service';

export type TeardownReason = 'environment.deleted' | 'project.deleted';

export interface TeardownScope {
  projectId: string;
  organizationId: string;
  environmentId?: string;
  namespace: string;
  reason: TeardownReason;
  actor: { userId?: string; email?: string };
  keepData?: boolean;
}

export interface TeardownSummary {
  deployments: number;
  databases: number;
  jobs: number;
  buildsCancelled: number;
  registryRepositories: number;
  buildContexts: number;
  backupPrefixes: number;
  failures: string[];
}

@Injectable()
export class NamespaceTeardownService {
  private readonly logger = new Logger(NamespaceTeardownService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly docker: DockerService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly r2Proxy: R2ProxyService,
    private readonly tailscale: TailscaleService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef
  ) {}

  async teardown(scope: TeardownScope): Promise<TeardownSummary> {
    const summary: TeardownSummary = {
      deployments: 0,
      databases: 0,
      jobs: 0,
      buildsCancelled: 0,
      registryRepositories: 0,
      buildContexts: 0,
      backupPrefixes: 0,
      failures: []
    };
    const where = scope.environmentId
      ? { environmentId: scope.environmentId }
      : { projectId: scope.projectId };
    const fail = (what: string, err: unknown) => {
      const message = `${what}: ${(err as Error)?.message ?? String(err)}`;
      summary.failures.push(message);
      this.logger.warn(`teardown of ${scope.namespace} ${message}`);
    };

    await this.prisma.retiredNamespace
      .upsert({
        where: { namespace: scope.namespace },
        create: { namespace: scope.namespace },
        update: {}
      })
      .catch((err: unknown) => fail('retire the namespace', err));

    const deployments = await this.prisma.deployment.findMany({
      where,
      select: {
        id: true,
        name: true,
        buildStatus: true,
        buildContextKey: true,
        imageHistory: { select: { image: true } }
      }
    });
    for (const deployment of deployments) {
      summary.deployments += 1;
      if (deployment.buildStatus === 'building') {
        try {
          await this.docker.cancelBuildJobsByDeploymentId(deployment.id);
          summary.buildsCancelled += 1;
        } catch (err) {
          fail(`cancel build for ${deployment.name}`, err);
        }
      }
      const images = scope.keepData ? [] : deployment.imageHistory.map((entry) => entry.image);
      if (images.length > 0) {
        try {
          const { repositories, tags } = await splitRegistryCleanup(
            this.prisma,
            deployment.id,
            images
          );
          await this.docker.deleteRepositoriesFromRegistry(repositories);
          await this.docker.deleteArtifactsFromRegistry(tags);
          summary.registryRepositories += new Set(repositories.map((i) => i.split(':')[0])).size;
        } catch (err) {
          fail(`delete registry repositories for ${deployment.name}`, err);
        }
      }
      if (deployment.buildContextKey) {
        try {
          await this.storage.deleteBuildContext(deployment.buildContextKey);
          summary.buildContexts += 1;
        } catch (err) {
          fail(`delete build context for ${deployment.name}`, err);
        }
      }
      await this.notifications
        .purgeScope('deployment', deployment.id)
        .catch((err) => fail(`purge notifications for ${deployment.name}`, err));
      void this.audit.log({
        action: 'deployment.deleted',
        actorUserId: scope.actor.userId,
        actorEmail: scope.actor.email,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        deploymentId: deployment.id,
        targetType: 'deployment',
        targetId: deployment.id,
        targetLabel: deployment.name,
        metadata: { via: scope.reason, namespace: scope.namespace }
      });
    }

    const databases = await this.prisma.database.findMany({
      where,
      include: {
        project: {
          include: {
            organization: { omit: { backupR2AccessKey: false, backupR2SecretKey: false } }
          }
        }
      }
    });
    const { DatabasesService } = await import('./databases.service.js');
    const databasesService: DatabasesServiceType = this.moduleRef.get(DatabasesService, {
      strict: false
    });
    const { DatabaseTrashService } = await import('./database-trash.service.js');
    const trash = this.moduleRef.get(DatabaseTrashService, { strict: false });
    for (const database of databases) {
      summary.databases += 1;
      let kept = false;
      if (scope.reason === 'environment.deleted') {
        try {
          kept = Boolean(
            await trash.keep(database, {
              reason: 'environment',
              deletedBy: scope.actor.userId ?? null
            })
          );
        } catch (err) {
          fail(`keep ${database.name} in the trash`, err);
        }
      }
      if (kept || scope.keepData) {
        this.logger.warn(
          `teardown of ${scope.namespace} keeps the backups of ${database.name}${kept ? ' for 30 days so it can be brought back' : ': the namespace was removed in the cluster, so they are the only way back'}`
        );
      } else {
        try {
          await databasesService.purgeBackupObjects(database);
          if (database.namespace && database.clusterName) summary.backupPrefixes += 1;
        } catch (err) {
          fail(`purge backups for ${database.name}`, err);
        }
      }
      if (
        database.mode === 'cnpg' &&
        database.namespace &&
        database.clusterName &&
        database.namespace !== scope.namespace
      ) {
        try {
          await databasesService.removeClusterResources(database.namespace, database.clusterName);
        } catch (err) {
          fail(`remove the cluster of ${database.name} from ${database.namespace}`, err);
        }
      }
      if (database.r2ProxyAccessKey) {
        try {
          await this.r2Proxy.removeBinding(database.r2ProxyAccessKey);
        } catch (err) {
          fail(`remove backup proxy binding for ${database.name}`, err);
        }
      }
      await this.notifications
        .purgeScope('database', database.id)
        .catch((err) => fail(`purge notifications for ${database.name}`, err));
      void this.audit.log({
        action: 'database.deleted',
        actorUserId: scope.actor.userId,
        actorEmail: scope.actor.email,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        targetType: 'database',
        targetId: database.id,
        targetLabel: database.name,
        metadata: { via: scope.reason, namespace: scope.namespace }
      });
    }

    if (!scope.environmentId && !scope.keepData) {
      await trash
        .purgeForProject(scope.projectId)
        .catch((err) => fail('purge the backups of trashed databases', err));
    }

    const jobs = await this.prisma.job.findMany({ where, select: { id: true, name: true } });
    for (const job of jobs) {
      summary.jobs += 1;
      await this.notifications
        .purgeScope('job', job.id)
        .catch((err) => fail(`purge notifications for job ${job.name}`, err));
      void this.audit.log({
        action: 'job.deleted',
        actorUserId: scope.actor.userId,
        actorEmail: scope.actor.email,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        targetType: 'job',
        targetId: job.id,
        targetLabel: job.name,
        metadata: { via: scope.reason, namespace: scope.namespace }
      });
    }

    await this.tailscale
      .cleanupNamespace(scope.namespace)
      .catch((err) => fail('tailscale cleanup', err));

    return summary;
  }
}
