import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackupSyncService } from '../src/projects/backup-sync.service';
import {
  defaultBackupCronFor,
  LEGACY_DEFAULT_BACKUP_CRON,
  parseBackupWindow
} from '../src/projects/projects.utils';

const env = {} as NodeJS.ProcessEnv;

function fields(cron: string): { minute: number; hour: number; rest: string } {
  const [minute, hour, ...rest] = cron.split(' ');
  return { minute: Number(minute), hour: Number(hour), rest: rest.join(' ') };
}

test('the default backup schedule is stable for a cluster', () => {
  assert.equal(
    defaultBackupCronFor('ysws-a', 'pg-db', env),
    defaultBackupCronFor('ysws-a', 'pg-db', env)
  );
});

test('default backup schedules stay inside the window and spread across it', () => {
  const hours = new Set<number>();
  const perSlot = new Map<string, number>();
  for (let i = 0; i < 200; i += 1) {
    const cron = defaultBackupCronFor(`ns-${i}`, 'pg-db', env);
    const f = fields(cron);
    assert.equal(f.rest, '* * *');
    assert.ok(f.minute >= 0 && f.minute <= 59, cron);
    assert.ok(f.hour >= 1 && f.hour <= 5, cron);
    hours.add(f.hour);
    const key = `${f.hour}:${f.minute}`;
    perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
  }
  assert.equal(hours.size, 5);
  assert.ok(perSlot.size > 120, `only ${perSlot.size} distinct slots`);
  assert.ok(Math.max(...perSlot.values()) <= 5, 'one minute got crowded');
});

test('a configured window moves the schedules and a pinned cron wins outright', () => {
  for (let i = 0; i < 50; i += 1) {
    const f = fields(defaultBackupCronFor(`ns-${i}`, 'pg', { DEFAULT_DB_BACKUP_WINDOW: '22-23' }));
    assert.ok(f.hour === 22 || f.hour === 23);
  }
  assert.equal(
    defaultBackupCronFor('ns', 'pg', { DEFAULT_DB_BACKUP_CRON: '15 4 * * *' }),
    '15 4 * * *'
  );
});

test('an unusable window falls back to the default one', () => {
  assert.deepEqual(parseBackupWindow('5-1'), [1, 5]);
  assert.deepEqual(parseBackupWindow('nonsense'), [1, 5]);
  assert.deepEqual(parseBackupWindow('2-4'), [2, 4]);
});

function respreadHarness(rows: any[], live: Record<string, string | null>) {
  const upserts: string[] = [];
  const updates: Record<string, string> = {};
  const s = Object.create(BackupSyncService.prototype) as any;
  Object.assign(s, {
    logger: { warn() {}, log() {} },
    prisma: {
      database: {
        findMany: async (q: any) =>
          rows.filter((r) => r.backupScheduleCron === q.where.backupScheduleCron),
        update: async ({ where, data }: any) => {
          updates[where.id] = data.backupScheduleCron;
          return {};
        }
      }
    },
    k8sCnpg: {
      getScheduledBackupSchedule: async (_ns: string, name: string) => live[name] ?? null,
      upsertScheduledBackup: async (ns: string, name: string, cron: string) => {
        upserts.push(`${ns}/${name}:${cron}`);
      }
    }
  });
  return { s, upserts, updates };
}

test('the respread moves clusters off the shared 03:00 slot and leaves everyone else alone', async () => {
  const rows = [
    {
      id: 'legacy',
      namespace: 'ns-a',
      clusterName: 'pg-a',
      backupScheduleCron: LEGACY_DEFAULT_BACKUP_CRON
    },
    {
      id: 'edited',
      namespace: 'ns-b',
      clusterName: 'pg-b',
      backupScheduleCron: LEGACY_DEFAULT_BACKUP_CRON
    },
    { id: 'custom', namespace: 'ns-c', clusterName: 'pg-c', backupScheduleCron: '0 2 * * *' }
  ];
  const { s, upserts, updates } = respreadHarness(rows, {
    'pg-a': '0 0 3 * * *',
    'pg-b': '0 30 4 * * *',
    'pg-c': '0 0 2 * * *'
  });
  const prev = process.env.DEFAULT_DB_BACKUP_CRON;
  delete process.env.DEFAULT_DB_BACKUP_CRON;
  try {
    assert.equal(await s.respreadLegacySchedules(), 1);
  } finally {
    if (prev !== undefined) process.env.DEFAULT_DB_BACKUP_CRON = prev;
  }
  const spread = defaultBackupCronFor('ns-a', 'pg-a', env);
  assert.deepEqual(upserts, [`ns-a/pg-a:0 ${spread}`]);
  assert.equal(updates.legacy, spread);
  assert.equal(updates.edited, '30 4 * * *');
  assert.equal(updates.custom, undefined);
});

test('the respread does nothing while the operator pins one schedule for everyone', async () => {
  const { s, upserts } = respreadHarness(
    [
      {
        id: 'legacy',
        namespace: 'ns',
        clusterName: 'pg',
        backupScheduleCron: LEGACY_DEFAULT_BACKUP_CRON
      }
    ],
    { pg: '0 0 3 * * *' }
  );
  const prev = process.env.DEFAULT_DB_BACKUP_CRON;
  process.env.DEFAULT_DB_BACKUP_CRON = '0 3 * * *';
  try {
    assert.equal(await s.respreadLegacySchedules(), 0);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_DB_BACKUP_CRON;
    else process.env.DEFAULT_DB_BACKUP_CRON = prev;
  }
  assert.deepEqual(upserts, []);
});
