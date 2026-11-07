import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';
import {
  assertValidClaimName,
  assertValidVolumeSize,
  maxVolumeSize
} from '../src/kubernetes/pvc-limits';

test('volume sizes accept the common range and refuse the extremes', () => {
  assert.equal(assertValidVolumeSize('1Gi'), '1Gi');
  assert.equal(assertValidVolumeSize('500Mi'), '500Mi');
  assert.equal(assertValidVolumeSize('200Gi'), '200Gi');
  assert.throws(() => assertValidVolumeSize('201Gi'), BadRequestException);
  assert.throws(() => assertValidVolumeSize('100Ti'), BadRequestException);
  assert.throws(() => assertValidVolumeSize('1Pi'), BadRequestException);
  assert.throws(() => assertValidVolumeSize('1e3'), BadRequestException);
  assert.throws(() => assertValidVolumeSize('1Mi'), BadRequestException);
  assert.throws(() => assertValidVolumeSize('-5Gi'), BadRequestException);
  assert.throws(() => assertValidVolumeSize(undefined), BadRequestException);
});

test('the cap is operator-configurable', () => {
  assert.equal(maxVolumeSize({ MAX_VOLUME_SIZE: '1Ti' } as any), '1Ti');
  assert.doesNotThrow(() => assertValidVolumeSize('500Gi', { MAX_VOLUME_SIZE: '1Ti' } as any));
  assert.equal(maxVolumeSize({ MAX_VOLUME_SIZE: 'lots' } as any), '200Gi');
});

test('claim names must be DNS-1123 labels', () => {
  assert.equal(assertValidClaimName('data-1'), 'data-1');
  assert.throws(() => assertValidClaimName('Data_1'), BadRequestException);
  assert.throws(() => assertValidClaimName('a'.repeat(64)), BadRequestException);
});

function serviceWith(existing: any | null) {
  const calls: { method: string; args: any[] }[] = [];
  const kc = {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              if (method === 'readNamespacedPersistentVolumeClaim') {
                if (existing) return { body: existing };
                const e: any = new Error('nf');
                e.response = { statusCode: 404 };
                throw e;
              }
              return { body: {} };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  } as any;
  const svc: any = new (KubernetesService as any)({});
  svc.kc = kc;
  return { svc, calls };
}

test('createPVC refuses oversized, malformed and database-owned claims', async () => {
  const fresh = serviceWith(null);
  await assert.rejects(fresh.svc.createPVC('ns', 'data', '100Ti'), BadRequestException);
  await assert.rejects(fresh.svc.createPVC('ns', 'Bad_Name', '1Gi'), BadRequestException);
  assert.ok(!fresh.calls.some((c) => c.method === 'createNamespacedPersistentVolumeClaim'));

  await fresh.svc.createPVC('ns', 'data', '5Gi');
  const created = fresh.calls.find((c) => c.method === 'createNamespacedPersistentVolumeClaim')!;
  assert.deepEqual(created.args[1].spec.accessModes, ['ReadWriteOnce']);
  assert.equal(created.args[1].spec.resources.requests.storage, '5Gi');

  const db = serviceWith({
    metadata: { labels: { 'cnpg.io/cluster': 'db' } },
    spec: { resources: { requests: { storage: '1Gi' } } }
  });
  await assert.rejects(db.svc.createPVC('ns', 'db-1', '2Gi'), BadRequestException);
  assert.ok(!db.calls.some((c) => c.method === 'patchNamespacedPersistentVolumeClaim'));

  const legacy = serviceWith({
    metadata: { labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
    spec: { resources: { requests: { storage: '500Gi' } } }
  });
  await legacy.svc.createPVC('ns', 'big', '500Gi');
  assert.ok(!legacy.calls.some((c) => c.method === 'patchNamespacedPersistentVolumeClaim'));
});
