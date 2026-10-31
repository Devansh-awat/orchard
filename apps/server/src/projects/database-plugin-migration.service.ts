import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { clusterArchivesWithPlugin, DEFAULT_SIDECAR } from '../kubernetes/cnpg-recovery';
import { parseMemory } from '../kubernetes/quantity';
import { toQuartzCron } from './projects.utils';

export const PLUGIN_MIGRATION_HALT_KEY = 'db_barman_plugin_migration_halt';

const REGRESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export function migrationRegression(clusters: any[], now = Date.now()): string | null {
  for (const c of clusters) {
    if (!clusterArchivesWithPlugin(c?.spec)) continue;
    const archiving = (c?.status?.conditions ?? []).find(
      (x: any) => x?.type === 'ContinuousArchiving'
    );
    if (archiving?.status !== 'False') continue;
    const since = Date.parse(archiving.lastTransitionTime ?? '');
    if (!since || now - since > REGRESSION_WINDOW_MS) continue;
    return `${c.metadata?.namespace}/${c.metadata?.name} stopped archiving on the plugin: ${archiving.message ?? 'no message'}`;
  }
  return null;
}

function batchSize(): number {
  const n = Number.parseInt(process.env.CNPG_PLUGIN_MIGRATION_BATCH || '', 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 3;
}

export interface MigrationStatus {
  enabled: boolean;
  pluginInstalled: boolean;
  halted: string | null;
  migrated: number;
  remaining: number;
}

@Injectable()
export class DatabasePluginMigrationService {
  private readonly logger = new Logger(DatabasePluginMigrationService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly leader: LeaderElectionService,
    private readonly settings: InstanceSettingsService
  ) {}

  async status(): Promise<MigrationStatus> {
    const [enabled, pluginInstalled, halted, migrated, remaining] = await Promise.all([
      this.settings.isDatabaseToggleOn('pluginMigration'),
      this.k8sCnpg.barmanPluginInstalled().catch(() => false),
      this.settings.get(PLUGIN_MIGRATION_HALT_KEY),
      this.prisma.database.count({ where: { mode: 'cnpg', backupMethod: 'plugin' } }),
      this.prisma.database.count({
        where: { mode: 'cnpg', OR: [{ backupMethod: null }, { backupMethod: 'barman' }] }
      })
    ]);
    return { enabled, pluginInstalled, halted, migrated, remaining };
  }

  async resume(): Promise<MigrationStatus> {
    await this.settings.delete(PLUGIN_MIGRATION_HALT_KEY);
    return this.status();
  }

  @Interval(10 * 60 * 1000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.settings.isDatabaseToggleOn('pluginMigration'))) return;
      if (await this.settings.get(PLUGIN_MIGRATION_HALT_KEY)) return;
      if (!(await this.k8sCnpg.barmanPluginInstalled())) return;
      if (await this.recentFailure()) return;
      const rows = await this.prisma.database.findMany({
        where: {
          mode: 'cnpg',
          status: 'ready',
          namespace: { not: null },
          clusterName: { not: null },
          OR: [{ backupMethod: null }, { backupMethod: 'barman' }]
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize() * 4
      });
      let done = 0;
      for (const db of rows) {
        if (done >= batchSize()) break;
        const cluster = await this.k8sCnpg.readCluster(db.namespace!, db.clusterName!);
        if (!cluster) continue;
        if (cluster.metadata?.annotations?.['cnpg.io/hibernation'] === 'on') continue;
        if (clusterArchivesWithPlugin(cluster.spec)) {
          await this.prisma.database.update({
            where: { id: db.id },
            data: { backupMethod: 'plugin' }
          });
          continue;
        }
        if (!cluster.spec?.backup?.barmanObjectStore) continue;
        const instances = Math.max(1, Number(cluster.spec?.instances ?? 1));
        const headroom = await this.k8sCnpg.namespaceMemoryHeadroom(db.namespace!);
        const needed = parseMemory(DEFAULT_SIDECAR.memoryLimit) * instances;
        if (headroom !== null && headroom < needed) {
          this.logger.warn(
            `plugin migration skips ${db.namespace}/${db.clusterName}: ${headroom} bytes of quota left, the sidecar needs ${needed}`
          );
          continue;
        }
        try {
          const migrated = await this.k8sCnpg.migrateClusterToPlugin(
            db.namespace!,
            db.clusterName!
          );
          if (!migrated) continue;
          await this.prisma.database.update({
            where: { id: db.id },
            data: { backupMethod: 'plugin', backupServerName: migrated.serverName }
          });
          if (db.backupScheduleCron && !db.backupScheduleDisabled) {
            await this.k8sCnpg
              .upsertScheduledBackup(
                db.namespace!,
                db.clusterName!,
                toQuartzCron(db.backupScheduleCron)
              )
              .catch((e) =>
                this.logger.warn(
                  `schedule for ${db.clusterName} not switched to the plugin: ${k8sErrorMessage(e)}`
                )
              );
          }
          done += 1;
          this.logger.log(`moved ${db.namespace}/${db.clusterName} to the barman cloud plugin`);
        } catch (e: any) {
          const reason = `${db.namespace}/${db.clusterName}: ${k8sErrorMessage(e)}`;
          await this.settings.set(PLUGIN_MIGRATION_HALT_KEY, reason);
          this.logger.warn(`plugin migration halted at ${reason}`);
          return;
        }
      }
    } catch (e: any) {
      this.logger.warn(`plugin migration tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async recentFailure(): Promise<boolean> {
    const clusters = await this.k8sCnpg.listAllCnpgClusters();
    const reason = migrationRegression(clusters);
    if (!reason) return false;
    await this.settings.set(PLUGIN_MIGRATION_HALT_KEY, reason);
    this.logger.warn(`plugin migration halted: ${reason}`);
    return true;
  }
}
