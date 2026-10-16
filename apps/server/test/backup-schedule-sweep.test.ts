import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackupSyncService } from '../src/projects/backup-sync.service';

test('the schedule sweep leaves a database whose schedule was turned off alone', async () => {
  const created: string[] = [];
  const s = Object.create(BackupSyncService.prototype) as any;
  Object.assign(s, {
    logger: { warn() {}, log() {} },
    prisma: {
      database: {
        findMany: async () => [
          {
            id: 'off',
            namespace: 'ns',
            clusterName: 'pg-off',
            backupScheduleCron: null,
            backupScheduleDisabled: true,
            _count: { backups: 0 }
          },
          {
            id: 'lost',
            namespace: 'ns',
            clusterName: 'pg-lost',
            backupScheduleCron: '0 4 * * *',
            backupScheduleDisabled: false,
            _count: { backups: 3 }
          }
        ],
        update: async () => ({})
      }
    },
    k8sCnpg: {
      isCnpgBackupConfigured: async () => true,
      hasScheduledBackup: async () => false,
      upsertScheduledBackup: async (_ns: string, name: string, cron: string) => {
        created.push(`${name}:${cron}`);
      }
    }
  });
  await s.ensureBackupSchedules();
  assert.deepEqual(created, ['pg-lost:0 0 4 * * *']);
});
