import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  POD_EXEC_DENIED_MESSAGE,
  assertPodExecable,
  checkPodExecable,
  isExecableAppPod
} from '../src/kubernetes/pod-exec-policy';

const app = { 'app.kubernetes.io/name': 'web', 'app.kubernetes.io/managed-by': 'orchard' };

test('tenant app pods are exec-able', () => {
  assert.equal(isExecableAppPod({ ...app, 'pod-template-hash': 'abc' }), true);
});

test('cnpg instance pods are refused', () => {
  assert.equal(
    isExecableAppPod({
      'cnpg.io/cluster': 'db',
      'cnpg.io/podRole': 'instance',
      'app.kubernetes.io/managed-by': 'orchard',
      'app.kubernetes.io/name': 'db'
    }),
    false
  );
  assert.equal(isExecableAppPod({ 'cnpg.io/cluster': 'db' }), false);
});

test('pooler pods are refused', () => {
  assert.equal(isExecableAppPod({ ...app, 'cnpg.io/poolerName': 'db-pooler-rw' }), false);
  assert.equal(isExecableAppPod({ ...app, 'app.kubernetes.io/name': 'db-pgbouncer' }), false);
});

test('tailscale proxy pods are refused', () => {
  assert.equal(
    isExecableAppPod({
      ...app,
      'app.kubernetes.io/name': 'ts--proxy--web',
      'orchard.my/tailscale': 'true',
      'orchard.my/target-deployment': 'web'
    }),
    false
  );
});

test('job, build and unmanaged pods are refused', () => {
  assert.equal(
    isExecableAppPod({ 'app.kubernetes.io/managed-by': 'orchard-job', 'orchard/job-id': 'j' }),
    false
  );
  assert.equal(isExecableAppPod({ ...app, 'orchard/job-id': 'j' }), false);
  assert.equal(isExecableAppPod({ 'app.kubernetes.io/name': 'web' }), false);
  assert.equal(isExecableAppPod({}), false);
  assert.equal(isExecableAppPod(undefined), false);
});

test('assertPodExecable maps verdicts to 403 and 404', async () => {
  await assert.rejects(
    assertPodExecable(async () => ({ 'cnpg.io/cluster': 'db' }), 'ns', 'db-1'),
    (e: unknown) => e instanceof ForbiddenException && e.message === POD_EXEC_DENIED_MESSAGE
  );
  await assert.rejects(
    assertPodExecable(
      async () => {
        throw new Error('nope');
      },
      'ns',
      'gone'
    ),
    NotFoundException
  );
  await assert.doesNotReject(assertPodExecable(async () => app, 'ns', 'web-1'));
  assert.equal(await checkPodExecable(async () => app, 'ns', 'web-1'), 'ok');
});
