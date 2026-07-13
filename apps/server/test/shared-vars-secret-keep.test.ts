import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';

process.env.SECRETS_ENCRYPTION_KEY = 'shared-vars-test-key';

import { EnvironmentSharedVarsService } from '../src/projects/environment-shared-vars.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

type Row = { key: string; value: string; secret: boolean };

function harness(initial: Row[]) {
  const crypto = new SecretCryptoService();
  let state: Row[] = initial.map((r) => ({ ...r, value: crypto.encryptIfSecret(r.value, r.secret) }));
  const events: any[] = [];
  const prisma: any = {
    environment: {
      findUnique: async () => ({
        id: 'env-1',
        name: 'production',
        project: { id: 'proj-1', organizationId: 'org-1' },
      }),
    },
    environmentSharedVar: {
      findMany: async () => state.map((r) => ({ ...r })),
    },
    deployment: { findMany: async () => [] },
    $transaction: async (fn: any) =>
      fn({
        environmentSharedVar: {
          deleteMany: async () => {
            state = [];
          },
          createMany: async ({ data }: { data: any[] }) => {
            state = data.map((d) => ({ key: d.key, value: d.value, secret: d.secret }));
          },
        },
      }),
  };
  const svc = new EnvironmentSharedVarsService(
    prisma,
    { log: async () => {} } as any,
    { emit: (e: any) => events.push(e) } as any,
    { getKubernetesDeployment: async () => null } as any,
    crypto,
  );
  return { svc, crypto, events, rows: () => state };
}

test('null value keeps an existing secret', async () => {
  const h = harness([{ key: 'API_KEY', value: 's3cret', secret: true }]);
  const res = await h.svc.updateSharedVars(
    'env-1',
    [{ key: 'API_KEY', value: null, secret: true }],
    'user-1',
  );
  assert.equal(h.rows().length, 1);
  assert.equal(h.crypto.isEncrypted(h.rows()[0].value), true);
  assert.equal(h.crypto.decrypt(h.rows()[0].value), 's3cret');
  assert.deepEqual(res.vars, [{ key: 'API_KEY', secret: true, value: null }]);
});

test('empty value on a still-secret row keeps the stored value', async () => {
  const h = harness([{ key: 'API_KEY', value: 's3cret', secret: true }]);
  await h.svc.updateSharedVars('env-1', [{ key: 'API_KEY', value: '', secret: true }], 'user-1');
  assert.equal(h.crypto.decrypt(h.rows()[0].value), 's3cret');
});

test('a provided value replaces the secret', async () => {
  const h = harness([{ key: 'API_KEY', value: 's3cret', secret: true }]);
  await h.svc.updateSharedVars(
    'env-1',
    [{ key: 'API_KEY', value: 'rotated', secret: true }],
    'user-1',
  );
  assert.equal(h.crypto.decrypt(h.rows()[0].value), 'rotated');
});

test('null keeps an existing non-secret value', async () => {
  const h = harness([{ key: 'URL', value: 'https://x', secret: false }]);
  await h.svc.updateSharedVars('env-1', [{ key: 'URL', value: null, secret: false }], 'user-1');
  assert.equal(h.rows()[0].value, 'https://x');
});

test('empty value on a non-secret row is stored empty', async () => {
  const h = harness([{ key: 'URL', value: 'https://x', secret: false }]);
  await h.svc.updateSharedVars('env-1', [{ key: 'URL', value: '', secret: false }], 'user-1');
  assert.equal(h.rows()[0].value, '');
});

test('null promotes a plain var to secret without resending the value', async () => {
  const h = harness([{ key: 'URL', value: 'https://x', secret: false }]);
  await h.svc.updateSharedVars('env-1', [{ key: 'URL', value: null, secret: true }], 'user-1');
  assert.equal(h.crypto.isEncrypted(h.rows()[0].value), true);
  assert.equal(h.crypto.decrypt(h.rows()[0].value), 'https://x');
});

test('empty value marking a plain var secret stores empty, not the old value', async () => {
  const h = harness([{ key: 'URL', value: 'https://x', secret: false }]);
  await h.svc.updateSharedVars('env-1', [{ key: 'URL', value: '', secret: true }], 'user-1');
  assert.equal(h.crypto.decrypt(h.rows()[0].value), '');
});

test('new secret key with null value is stored empty', async () => {
  const h = harness([]);
  await h.svc.updateSharedVars('env-1', [{ key: 'NEW', value: null, secret: true }], 'user-1');
  assert.equal(h.rows().length, 1);
  assert.equal(h.crypto.decrypt(h.rows()[0].value), '');
});

test('un-marking a secret without a value is rejected', async () => {
  const h = harness([{ key: 'API_KEY', value: 's3cret', secret: true }]);
  await assert.rejects(
    h.svc.updateSharedVars('env-1', [{ key: 'API_KEY', value: null, secret: false }], 'user-1'),
    BadRequestException,
  );
  assert.equal(h.crypto.decrypt(h.rows()[0].value), 's3cret');
});

test('omitted keys are removed and sharedvars.changed still fires', async () => {
  const h = harness([
    { key: 'API_KEY', value: 's3cret', secret: true },
    { key: 'URL', value: 'https://x', secret: false },
  ]);
  await h.svc.updateSharedVars('env-1', [{ key: 'API_KEY', value: null, secret: true }], 'user-1');
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].key, 'API_KEY');
  assert.equal(
    h.events.some((e) => e.type === 'sharedvars.changed' && e.id === 'env-1'),
    true,
  );
});
