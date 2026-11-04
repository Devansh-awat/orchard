import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterSpecValues,
  majorFromImage,
  parameterDrift,
  specColumnUpdate
} from '../src/kubernetes/cnpg-spec-sync';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const hardware = {
  metadata: { namespace: 'ysws-telescreen', name: 'pg-hardware' },
  spec: {
    instances: 1,
    imageName: 'ghcr.io/cloudnative-pg/postgresql:18',
    storage: { size: '30Gi' },
    postgresql: { shared_preload_libraries: ['pg_stat_statements'] },
    resources: { limits: { cpu: '1', memory: '8Gi' }, requests: { cpu: '100m', memory: '8Gi' } }
  }
};

const row = {
  storageSize: '30Gi',
  replicas: 1,
  pgMajor: 18,
  sharedPreloadLibs: ['pg_stat_statements'],
  cpuRequestMilli: 1000,
  memoryRequestBytes: BigInt(8 * GiB)
};

const pinned = {
  current: { cpuMilli: 1000, memoryBytes: 8 * GiB },
  defaults: { cpuMilli: 500, memoryBytes: GiB }
};

test('the major version is the leading number of the image tag', () => {
  assert.equal(majorFromImage('ghcr.io/cloudnative-pg/postgresql:17'), 17);
  assert.equal(majorFromImage('ghcr.io/cloudnative-pg/postgresql:16.4-bookworm'), 16);
  assert.equal(majorFromImage('registry:5000/postgis:17-3.4@sha256:abc'), 17);
  assert.equal(majorFromImage('ghcr.io/cloudnative-pg/postgresql'), null);
  assert.equal(majorFromImage('postgres:latest'), null);
  assert.equal(majorFromImage(undefined), null);
});

test('a cluster that matches its row changes nothing', () => {
  assert.deepEqual(specColumnUpdate(row, clusterSpecValues(hardware), pinned), {});
});

test('a volume, instance count, image or preload list edited in kubernetes lands on the row', () => {
  const edited = structuredClone(hardware);
  edited.spec.storage.size = '40Gi';
  edited.spec.instances = 2;
  edited.spec.imageName = 'ghcr.io/cloudnative-pg/postgresql:17';
  edited.spec.postgresql.shared_preload_libraries = ['pg_stat_statements', 'timescaledb'];
  assert.deepEqual(specColumnUpdate(row, clusterSpecValues(edited), pinned), {
    storageSize: '40Gi',
    replicas: 2,
    pgMajor: 17,
    sharedPreloadLibs: ['pg_stat_statements', 'timescaledb']
  });
});

test('a cluster without a preload list matches a row that has none', () => {
  const bare = structuredClone(hardware) as any;
  delete bare.spec.postgresql;
  assert.deepEqual(
    specColumnUpdate({ ...row, sharedPreloadLibs: null }, clusterSpecValues(bare), pinned),
    {}
  );
  assert.deepEqual(
    specColumnUpdate({ ...row, sharedPreloadLibs: [] }, clusterSpecValues(bare), pinned),
    {}
  );
});

test('resources edited in kubernetes pin the row, and landing on the default clears it', () => {
  const edited = structuredClone(hardware);
  edited.spec.resources.limits = { cpu: '2', memory: '16Gi' };
  assert.deepEqual(specColumnUpdate(row, clusterSpecValues(edited), pinned), {
    cpuRequestMilli: 2000,
    memoryRequestBytes: BigInt(16 * GiB)
  });
  edited.spec.resources.limits = { cpu: '500m', memory: '1Gi' };
  assert.deepEqual(specColumnUpdate(row, clusterSpecValues(edited), pinned), {
    cpuRequestMilli: null,
    memoryRequestBytes: null
  });
});

test('a row on the default stays null while the cluster runs the default', () => {
  const onDefault = { ...row, cpuRequestMilli: null, memoryRequestBytes: null };
  const resources = { current: pinned.defaults, defaults: pinned.defaults };
  const cluster = structuredClone(hardware);
  cluster.spec.resources.limits = { cpu: '500m', memory: '1Gi' };
  assert.deepEqual(specColumnUpdate(onDefault, clusterSpecValues(cluster), resources), {});
});

test('a row below the memory floor matches a cluster provisioned at the floor', () => {
  const tiny = { ...row, memoryRequestBytes: BigInt(128 * MiB) };
  const cluster = structuredClone(hardware);
  cluster.spec.resources.limits.memory = '256Mi';
  const resources = {
    current: { cpuMilli: 1000, memoryBytes: 256 * MiB },
    defaults: pinned.defaults
  };
  assert.deepEqual(specColumnUpdate(tiny, clusterSpecValues(cluster), resources), {});
});

test('a raised floor leaves a database below it alone until its next restart', () => {
  const cluster = structuredClone(hardware);
  cluster.spec.resources.limits = { cpu: '500m', memory: '256Mi' };
  const resources = { current: pinned.defaults, defaults: pinned.defaults };
  const noOwnSize = { ...row, cpuRequestMilli: null, memoryRequestBytes: null };
  assert.equal(
    specColumnUpdate(noOwnSize, clusterSpecValues(cluster), {
      current: { cpuMilli: 500, memoryBytes: 512 * MiB },
      defaults: { cpuMilli: 500, memoryBytes: 512 * MiB }
    }).memoryRequestBytes,
    undefined
  );
  const tiny = { ...row, memoryRequestBytes: BigInt(128 * MiB) };
  assert.equal(
    specColumnUpdate(tiny, clusterSpecValues(cluster), resources).memoryRequestBytes,
    undefined
  );
  const edited = { ...row, memoryRequestBytes: BigInt(2048 * MiB) };
  assert.equal(
    specColumnUpdate(edited, clusterSpecValues(cluster), resources).memoryRequestBytes,
    BigInt(256 * MiB)
  );
});

test('without resolved resources the cpu and memory columns are left alone', () => {
  const edited = structuredClone(hardware);
  edited.spec.resources.limits = { cpu: '4', memory: '32Gi' };
  assert.deepEqual(specColumnUpdate(row, clusterSpecValues(edited), null), {});
});

test('parameter drift names values the cluster runs that orchard did not set', () => {
  const keys = ['max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem'];
  const baseline = { max_connections: '100', shared_buffers: '2GB' };
  const live = {
    max_connections: '100',
    shared_buffers: '2GB',
    work_mem: '8MB',
    maintenance_work_mem: '256MB',
    default_transaction_read_only: 'on'
  };
  assert.deepEqual(parameterDrift({ maintenance_work_mem: '256MB' }, baseline, live, keys), {
    work_mem: '8MB'
  });
  assert.deepEqual(
    parameterDrift({ maintenance_work_mem: '512MB', statement_timeout: '1000' }, baseline, live, [
      ...keys,
      'statement_timeout'
    ]),
    { work_mem: '8MB', maintenance_work_mem: '256MB', statement_timeout: null }
  );
  assert.deepEqual(parameterDrift({}, baseline, null, keys), {});
});

function consumerWith(dbRow: Record<string, unknown>, quotas: unknown) {
  const updates: any[] = [];
  const logs: string[] = [];
  const svc = Object.create(CnpgConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    prisma: {
      database: {
        findUnique: async () => dbRow,
        update: async (args: any) => {
          updates.push(args.data);
          return {};
        }
      }
    },
    moduleRef: { get: () => quotas }
  });
  return { svc, updates, logs };
}

const ctx = { databaseId: 'db-1', orgId: 'o', projectId: 'p' };

test('a cluster event writes only the columns that drifted', async () => {
  const quotas = {
    resolvePodResources: async (_p: string, o: any) => ({
      cpuMilli: o?.cpuRequestMilli ?? 500,
      memoryBytes: o?.memoryRequestBytes ?? GiB
    })
  };
  const { svc, updates, logs } = consumerWith(
    { ...row, status: 'ready', importBoosted: false, storageSize: '29Gi' },
    quotas
  );
  await svc.syncSpecColumns(ctx, 'ysws-telescreen', 'pg-hardware', hardware);
  assert.deepEqual(updates, [{ storageSize: '30Gi' }]);
  assert.match(logs[0], /took storageSize from the cluster spec/);

  const again = consumerWith({ ...row, status: 'ready', importBoosted: false }, quotas);
  await again.svc.syncSpecColumns(ctx, 'ysws-telescreen', 'pg-hardware', hardware);
  assert.deepEqual(again.updates, []);
});

test('an import boost never leaks into the row', async () => {
  const boosted = structuredClone(hardware);
  boosted.spec.resources.limits = { cpu: '4', memory: '16Gi' };
  const quotas = {
    resolvePodResources: async () => {
      throw new Error('should not resolve while boosted');
    }
  };
  const { svc, updates } = consumerWith({ ...row, status: 'ready', importBoosted: true }, quotas);
  await svc.syncSpecColumns(ctx, 'ysws-telescreen', 'pg-hardware', boosted);
  assert.deepEqual(updates, []);
});

test('a database being deleted is left alone', async () => {
  const edited = structuredClone(hardware);
  edited.spec.storage.size = '40Gi';
  const { svc, updates } = consumerWith({ ...row, status: 'deleting' }, null);
  await svc.syncSpecColumns(ctx, 'ysws-telescreen', 'pg-hardware', edited);
  assert.deepEqual(updates, []);
});
