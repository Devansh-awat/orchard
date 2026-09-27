import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repairedCaBundle, walCapPatchFor } from '../src/kubernetes/cnpg-defaults';
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
  const clusters: Record<string, any> = {
    'ns-a/db-a': {
      spec: {
        storage: { size: '10Gi' },
        postgresql: { parameters: {} },
        certificates: { serverCASecret: 'wildcard-db-tls' }
      }
    },
    'ns-b/db-b': {
      spec: {
        storage: { size: '5Gi' },
        postgresql: { parameters: { max_slot_wal_keep_size: '1GB' } }
      }
    }
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
              patches.push(`${ns}/${name}:${JSON.stringify(body.spec.postgresql.parameters)}`);
              return {};
            }
          }
        : {
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
  Object.assign(svc, {
    logger: { warn() {}, log() {} },
    kubernetes: { kc },
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
  assert.deepEqual(result, { walCapped: 1, caRepaired: 1, failed: 0 });
  assert.deepEqual(patches, ['ns-a/db-a:{"max_slot_wal_keep_size":"2GB"}']);
  assert.deepEqual(secretPatches, ['ns-a']);

  member = false;
  assert.equal(await svc.reconcileClusterDefaults(), null);
});
