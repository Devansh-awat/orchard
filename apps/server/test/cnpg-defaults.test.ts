import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  laggingDataVolumes,
  repairedCaBundle,
  tuningPatchFor,
  walArchivePatchFor,
  walCapPatchFor
} from '../src/kubernetes/cnpg-defaults';
import { pemCertificates, completeChain } from '../src/kubernetes/tls-secret-sync';

const intermediates = pemCertificates(
  readFileSync(new URL('./fixtures/letsencrypt-ye-intermediates.pem', import.meta.url), 'utf8')
);
const b64 = (certs: string[]) => Buffer.from(`${certs.join('\n')}\n`).toString('base64');

test('a cluster without the slot cap gets one sized to its disk, one that has it is left alone', () => {
  assert.deepEqual(
    walCapPatchFor({ spec: { storage: { size: '10Gi' }, postgresql: { parameters: {} } } }),
    {
      max_slot_wal_keep_size: '2GB'
    }
  );
  assert.equal(
    walCapPatchFor({
      spec: {
        storage: { size: '10Gi' },
        postgresql: { parameters: { max_slot_wal_keep_size: '512MB' } }
      }
    }),
    null
  );
});

test('archiving gets parallel uploads only where a backup store exists and has none yet', () => {
  assert.deepEqual(walArchivePatchFor({ spec: { backup: { barmanObjectStore: {} } } }), {
    maxParallel: 4
  });
  assert.deepEqual(
    walArchivePatchFor({
      spec: { backup: { barmanObjectStore: { wal: { maxParallel: 1 } } } }
    }),
    { maxParallel: 4 }
  );
  assert.equal(
    walArchivePatchFor({
      spec: { backup: { barmanObjectStore: { wal: { maxParallel: 8 } } } }
    }),
    null
  );
  assert.equal(walArchivePatchFor({ spec: {} }), null);
  assert.equal(walArchivePatchFor({ spec: { backup: { barmanObjectStore: null } } }), null);
});

test('a database below the memory floor is raised and retuned, a healthy one is never grown', () => {
  const small = {
    spec: {
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '100m', memory: '128Mi' }
      },
      postgresql: { parameters: { shared_buffers: '128MB' } },
      backup: { barmanObjectStore: { data: { compression: 'gzip' }, wal: { maxParallel: 4 } } }
    }
  };
  assert.deepEqual(tuningPatchFor(small, {}), {
    resources: { requests: { memory: '256Mi' }, limits: { memory: '256Mi' } },
    postgresql: { parameters: { shared_buffers: '64MB' } },
    backup: { barmanObjectStore: { data: null } }
  });
  assert.deepEqual(
    tuningPatchFor(small, { pgParameters: { shared_buffers: '128MB' }, backupCompression: 'gzip' }),
    { resources: { requests: { memory: '256Mi' }, limits: { memory: '256Mi' } } }
  );
  const overReserved = {
    spec: {
      resources: { limits: { memory: '256Mi' } },
      postgresql: { parameters: { shared_buffers: '128MB' } },
      backup: { barmanObjectStore: {} }
    }
  };
  assert.deepEqual(tuningPatchFor(overReserved, {}), {
    postgresql: { parameters: { shared_buffers: '64MB' } }
  });
  const underTuned = {
    spec: {
      resources: { limits: { memory: '1Gi' } },
      postgresql: { parameters: { shared_buffers: '128MB' } },
      backup: { barmanObjectStore: { data: { compression: 'gzip' } } }
    }
  };
  assert.equal(tuningPatchFor(underTuned, {}), null);
  assert.equal(
    tuningPatchFor({ spec: { postgresql: { parameters: { shared_buffers: '128MB' } } } }, {}),
    null
  );
});

test('only data volumes smaller than the cluster spec are lagging', () => {
  const cluster = { spec: { storage: { size: '11Gi' } } };
  const pvc = (name: string, storage: string, role = 'PG_DATA') => ({
    metadata: { name, labels: { 'cnpg.io/pvcRole': role } },
    spec: { resources: { requests: { storage } } }
  });
  assert.deepEqual(
    laggingDataVolumes(cluster, [
      pvc('db-1', '3Gi'),
      pvc('db-2', '11Gi'),
      pvc('db-3', '20Gi'),
      pvc('db-1-wal', '1Gi', 'PG_WAL')
    ]),
    ['db-1']
  );
  assert.deepEqual(laggingDataVolumes({ spec: {} }, [pvc('db-1', '3Gi')]), []);
});

test('a ca.crt that stops at a cross-signed intermediate is completed, a full one is untouched', () => {
  const repaired = repairedCaBundle({ 'ca.crt': b64(intermediates) });
  assert.ok(repaired);
  const certs = pemCertificates(Buffer.from(repaired!, 'base64').toString('utf8'));
  assert.equal(certs.length, 4);
  assert.equal(repairedCaBundle({ 'ca.crt': repaired! }), null);
  assert.equal(repairedCaBundle({ 'ca.crt': b64(completeChain(intermediates)) }), null);
});

test('a secret with no ca.crt derives one from tls.crt and completes it', () => {
  const leafish = intermediates[0];
  const repaired = repairedCaBundle({ 'tls.crt': b64([leafish, ...intermediates]) });
  assert.ok(repaired);
  assert.equal(pemCertificates(Buffer.from(repaired!, 'base64').toString('utf8')).length, 4);
  assert.equal(repairedCaBundle({}), null);
});

import { K8sCnpgService } from '../src/kubernetes/k8s-cnpg.service';

test('the reconcile only patches what is missing and never runs off a non-member replica', async () => {
  const patches: string[] = [];
  const secretPatches: string[] = [];
  const pvcPatches: string[] = [];
  const clusters: Record<string, any> = {
    'ns-a/db-a': {
      spec: {
        storage: { size: '10Gi' },
        postgresql: { parameters: {} },
        backup: { barmanObjectStore: { wal: { compression: 'gzip' } } },
        certificates: { serverCASecret: 'wildcard-db-tls' }
      }
    },
    'ns-b/db-b': {
      spec: {
        storage: { size: '5Gi' },
        postgresql: { parameters: { max_slot_wal_keep_size: '1GB' } },
        backup: { barmanObjectStore: { wal: { compression: 'gzip', maxParallel: 4 } } }
      }
    }
  };
  const pvcs: Record<string, any[]> = {
    'ns-a': [
      {
        metadata: { name: 'db-a-1', labels: { 'cnpg.io/pvcRole': 'PG_DATA' } },
        spec: { resources: { requests: { storage: '3Gi' } } }
      }
    ],
    'ns-b': [
      {
        metadata: { name: 'db-b-1', labels: { 'cnpg.io/pvcRole': 'PG_DATA' } },
        spec: { resources: { requests: { storage: '5Gi' } } }
      }
    ]
  };
  const svc = Object.create(K8sCnpgService.prototype) as any;
  const kc = {
    makeApiClient: (cls: any) =>
      cls.name === 'CustomObjectsApi'
        ? {
            getNamespacedCustomObject: async (
              _g: string,
              _v: string,
              ns: string,
              _p: string,
              name: string
            ) => ({ body: clusters[`${ns}/${name}`] }),
            patchNamespacedCustomObject: async (
              _g: string,
              _v: string,
              ns: string,
              _p: string,
              name: string,
              body: any
            ) => {
              patches.push(`${ns}/${name}:${JSON.stringify(body.spec)}`);
              return {};
            }
          }
        : {
            listNamespacedPersistentVolumeClaim: async (ns: string) => ({
              body: { items: pvcs[ns] ?? [] }
            }),
            patchNamespacedPersistentVolumeClaim: async (name: string, ns: string, body: any) => {
              pvcPatches.push(`${ns}/${name}:${body.spec.resources.requests.storage}`);
              return {};
            },
            readNamespacedSecret: async (_n: string, ns: string) => ({
              body: { data: { 'ca.crt': b64(intermediates) }, metadata: { namespace: ns } }
            }),
            patchNamespacedSecret: async (_n: string, ns: string) => {
              secretPatches.push(ns);
              return {};
            }
          }
  };
  let member = true;
  const tlsRefreshed: string[] = [];
  Object.assign(svc, {
    syncPublicTlsSecret: async (ns: string) => {
      tlsRefreshed.push(ns);
      return true;
    },
    logger: { warn() {}, log() {} },
    kubernetes: { kc, ensureKubeConfig() {} },
    prisma: {
      database: {
        findMany: async () => [
          { namespace: 'ns-a', clusterName: 'db-a' },
          { namespace: 'ns-b', clusterName: 'db-b' }
        ]
      }
    },
    moduleRef: {
      get: (cls: any) =>
        cls.name === 'LeaseService' ? { canCoordinate: member } : { isLeader: () => member }
    },
    CNPG_GROUP: 'postgresql.cnpg.io',
    CNPG_VERSION: 'v1',
    CNPG_PLURAL: 'clusters',
    PUBLIC_TLS_LOCAL_SECRET: 'wildcard-db-tls'
  });
  Object.defineProperty(svc, 'kc', { get: () => kc });
  const result = await svc.reconcileClusterDefaults();
  assert.deepEqual(result, {
    walCapped: 1,
    archiveParallel: 1,
    retuned: 0,
    volumesResized: 1,
    tlsSynced: 1,
    caRepaired: 1,
    failed: 0
  });
  assert.deepEqual(tlsRefreshed, ['ns-a']);
  assert.deepEqual(patches, [
    'ns-a/db-a:{"postgresql":{"parameters":{"max_slot_wal_keep_size":"2GB"}},"backup":{"barmanObjectStore":{"wal":{"maxParallel":4}}}}'
  ]);
  assert.deepEqual(pvcPatches, ['ns-a/db-a-1:10Gi']);
  assert.deepEqual(secretPatches, ['ns-a']);

  member = false;
  assert.equal(await svc.reconcileClusterDefaults(), null);
});
