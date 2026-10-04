import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabasesService } from '../src/projects/databases.service';

function withPlatformBucket<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  process.env.R2_BACKUP_BUCKET = 'orchard-backups';
  process.env.R2_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'ak';
  process.env.R2_SECRET_ACCESS_KEY = 'sk';
  return fn().finally(() => {
    for (const k of [
      'R2_BACKUP_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY'
    ]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function svc(extra: Record<string, unknown> = {}) {
  const s = Object.create(DatabasesService.prototype) as any;
  Object.assign(s, {
    logger: { warn() {}, log() {} },
    crypto: { open: (v: string) => v },
    r2Proxy: {
      isEnabled: () => false,
      mintCredentials: () => ({ accessKey: 'a', secret: 'b' }),
      addBinding: async () => {}
    },
    ...extra
  });
  return s;
}

test('an organization with its own backup storage keeps it', async () => {
  await withPlatformBucket(async () => {
    const out = await svc().buildBackupR2Config(
      {
        backupR2Endpoint: 'https://own',
        backupR2Bucket: 'own-bucket',
        backupR2AccessKey: 'k',
        backupR2SecretKey: 's',
        backupR2Region: 'eu'
      },
      'ns',
      'pg-x'
    );
    assert.equal(out.r2.bucket, 'own-bucket');
    assert.equal(out.r2.region, 'eu');
  });
});

test('an organization without backup storage lands on the instance bucket, and nothing at all without one', async () => {
  await withPlatformBucket(async () => {
    const out = await svc().buildBackupR2Config({}, 'ns', 'pg-x');
    assert.equal(out.r2.bucket, 'orchard-backups');
    assert.equal(out.r2.endpoint, 'https://acct.r2.cloudflarestorage.com');
  });
  const none = await svc().buildBackupR2Config({}, 'ns', 'pg-x');
  assert.equal(none.r2, undefined);
});

test('the pass archives only clusters with no backup and creates the missing schedule, from a member replica only', async () => {
  await withPlatformBucket(async () => {
    const enabled: string[] = [];
    const schedules: string[] = [];
    let member = true;
    const s = svc({
      prisma: {
        database: {
          findMany: async () => [
            {
              id: '1',
              namespace: 'ns',
              clusterName: 'pg-a',
              r2ProxyAccessKey: null,
              backupScheduleCron: null,
              project: { organizationId: 'o' }
            },
            {
              id: '2',
              namespace: 'ns',
              clusterName: 'pg-b',
              r2ProxyAccessKey: null,
              backupScheduleCron: '0 4 * * *',
              project: { organizationId: 'o' }
            }
          ],
          update: async () => ({})
        },
        organization: { findUnique: async () => ({}) }
      },
      k8sCnpg: {
        isCnpgBackupConfigured: async (_ns: string, name: string) => name === 'pg-b',
        getCnpgBackupState: async (_ns: string, name: string) =>
          name === 'pg-b'
            ? {
                configured: true,
                endpointURL: 'https://acct.r2.cloudflarestorage.com',
                destinationPath: 's3://orchard-backups/ns/pg-b',
                secretAccessKeyId: 'ak'
              }
            : {
                configured: false,
                endpointURL: null,
                destinationPath: null,
                secretAccessKeyId: null
              },
        enableCnpgBackup: async (_ns: string, name: string, r2: any) => {
          enabled.push(`${name}@${r2.bucket}`);
        },
        hasScheduledBackup: async (_ns: string, name: string) => name === 'pg-b',
        upsertScheduledBackup: async (_ns: string, name: string, cron: string) => {
          schedules.push(`${name}:${cron}`);
        }
      },
      moduleRef: {
        get: (cls: any) =>
          cls.name === 'LeaseService' ? { canCoordinate: member } : { isLeader: () => member }
      }
    });
    assert.deepEqual(await s.reconcileDefaultBackups(), {
      archived: 1,
      repaired: 0,
      scheduled: 1,
      failed: 0
    });
    assert.deepEqual(enabled, ['pg-a@orchard-backups']);
    assert.equal(schedules.length, 1);
    assert.match(schedules[0], /^pg-a:/);
    member = false;
    assert.equal(await s.reconcileDefaultBackups(), null);
  });
});

test('an organization pointing at the instance bucket still goes through the proxy', async () => {
  await withPlatformBucket(async () => {
    const bindings: string[] = [];
    const s = svc({
      r2Proxy: {
        isEnabled: () => true,
        getEndpoint: () => 'http://r2-proxy:9000',
        mintCredentials: () => ({ accessKey: 'orch-a', secret: 'b' }),
        addBinding: async (b: any) => {
          bindings.push(`${b.bucket}:${b.prefix}`);
        }
      }
    });
    const shared = await s.buildBackupR2Config(
      {
        backupR2Endpoint: 'https://acct.r2.cloudflarestorage.com',
        backupR2Bucket: 'orchard-backups',
        backupR2AccessKey: 'real',
        backupR2SecretKey: 's'
      },
      'ns',
      'pg-x'
    );
    assert.equal(shared.r2.endpoint, 'http://r2-proxy:9000');
    assert.equal(shared.r2.accessKey, 'orch-a');
    assert.deepEqual(bindings, ['orchard-backups:ns/pg-x/']);

    const elsewhere = await s.buildBackupR2Config(
      {
        backupR2Endpoint: 'https://other.r2.cloudflarestorage.com',
        backupR2Bucket: 'their-bucket',
        backupR2AccessKey: 'real',
        backupR2SecretKey: 's'
      },
      'ns',
      'pg-x'
    );
    assert.equal(elsewhere.r2.endpoint, 'https://other.r2.cloudflarestorage.com');
    assert.equal(elsewhere.r2.accessKey, 'real');
    assert.equal(elsewhere.r2ProxyAccessKey, undefined);
  });
});

test('a cluster archiving to a stale endpoint is re-pointed by the pass', async () => {
  await withPlatformBucket(async () => {
    const enabled: string[] = [];
    const s = svc({
      prisma: {
        database: {
          findMany: async () => [
            {
              id: '1',
              namespace: 'ns',
              clusterName: 'pg-a',
              r2ProxyAccessKey: null,
              backupScheduleCron: null,
              project: { organizationId: 'o' }
            }
          ],
          update: async () => ({})
        },
        organization: { findUnique: async () => ({}) }
      },
      k8sCnpg: {
        getCnpgBackupState: async () => ({
          configured: true,
          endpointURL: 'https://65928e7e7265894b499567219490de12',
          destinationPath: 's3://orchard-backups/ns/pg-a',
          secretAccessKeyId: 'stale'
        }),
        enableCnpgBackup: async (_ns: string, name: string, r2: any) => {
          enabled.push(`${name}@${r2.endpoint}`);
        },
        hasScheduledBackup: async () => true
      },
      moduleRef: {
        get: (cls: any) =>
          cls.name === 'LeaseService' ? { canCoordinate: true } : { isLeader: () => true }
      }
    });
    assert.deepEqual(await s.reconcileDefaultBackups(), {
      archived: 0,
      repaired: 1,
      scheduled: 0,
      failed: 0
    });
    assert.deepEqual(enabled, ['pg-a@https://acct.r2.cloudflarestorage.com']);
  });
});
