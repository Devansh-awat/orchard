import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabasesService } from '../src/projects/databases.service';

const database = {
  id: 'db1',
  mode: 'cnpg',
  namespace: 'ns',
  clusterName: 'pg-a',
  dbUser: 'app',
  dbName: 'a',
  dbPassword: 'sealed',
  host: 'pg-a-rw.ns.svc.cluster.local',
  port: 5432,
  projectId: 'p1',
  environmentId: 'e1',
  publicEnabled: false,
  publicIp: null as string | null,
  publicPort: null as number | null,
  project: { organizationId: 'o1' }
};

function service(
  hostname: string,
  opts: { tlsFails?: boolean; row?: Partial<typeof database> } = {}
) {
  const row = { ...database, ...opts.row };
  const svc = Object.create(DatabasesService.prototype) as any;
  Object.assign(svc, {
    access: { assertDatabaseEditor: async () => ({ database: row }) },
    prisma: {
      organization: { findUnique: async () => ({ databasePublicIp: null }) },
      database: {
        findUnique: async () => row,
        findMany: async () => [],
        update: async ({ data }: any) => Object.assign(row, data)
      }
    },
    instanceConfig: { defaultPublicIp: () => '203.0.113.7' },
    crypto: { open: () => 'pw' },
    k8sNetwork: {
      exposeCnpgClusterPublic: async () => undefined,
      upsertPublicDatabaseNetworkPolicy: async () => undefined
    },
    k8sCnpg: {
      publicTlsHostname: () => hostname,
      legacyPublicTlsHostname: () => hostname,
      syncPublicTlsSecret: async () => {
        if (opts.tlsFails) throw new Error('no wildcard');
      },
      patchCnpgClusterTls: async () => undefined
    }
  });
  svc.pickFreePublicPort = async () => 31881;
  return svc;
}

test('with no TLS hostname the address is the public IP, with a mode that connects', async () => {
  const svc = service('');
  const result = await svc.enableDatabasePublic('db1', 'clerk');
  assert.equal(result.host, '203.0.113.7');
  assert.match(result.connectionString, /@203\.0\.113\.7:31881\/a\?sslmode=require$/);

  const creds = await svc.databaseConnection('db1');
  assert.match(creds.publicConnectionString, /@203\.0\.113\.7:31881\/a\?sslmode=require$/);
});

test('with a wildcard certificate wired in, clients can verify the hostname', async () => {
  const svc = service('ns-pg-a.db.example.com');
  const result = await svc.enableDatabasePublic('db1', 'clerk');
  assert.equal(result.host, 'ns-pg-a.db.example.com');
  assert.match(result.connectionString, /@ns-pg-a\.db\.example\.com:31881\/a\?sslmode=verify-full/);
});

test('when the certificate could not be wired in, it does not promise verification', async () => {
  const svc = service('ns-pg-a.db.example.com', { tlsFails: true });
  const result = await svc.enableDatabasePublic('db1', 'clerk');
  assert.equal(result.host, '203.0.113.7');
  assert.match(result.connectionString, /\?sslmode=require$/);
});

test('turning it on twice gives the same answer', async () => {
  const svc = service('', {
    row: { publicEnabled: true, publicIp: '203.0.113.7', publicPort: 31881 }
  });
  const result = await svc.enableDatabasePublic('db1', 'clerk');
  assert.match(result.connectionString, /@203\.0\.113\.7:31881\/a\?sslmode=require$/);
});
