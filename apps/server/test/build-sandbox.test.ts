import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sandboxFailureReason,
  sandboxPodDetail,
  sandboxStartFailure
} from '../src/docker/build-sandbox';

const KATA =
  'Failed to create pod sandbox: rpc error: code = Unknown desc = failed to start sandbox "abc": failed to create containerd task: failed to create shim task: annotation io.katacontainers.config.hypervisor.virtio_fs_extra_args is not enabled';

const KATA_ANNOTATION = 'io.katacontainers.config.hypervisor.virtio_fs_extra_args';

test('keeps the cause and drops the runtime preamble', () => {
  assert.equal(
    sandboxFailureReason(KATA),
    'annotation io.katacontainers.config.hypervisor.virtio_fs_extra_args is not enabled'
  );
  assert.equal(sandboxFailureReason('(combined from similar events): nope'), 'nope');
  assert.equal(sandboxFailureReason(null), '');
  assert.equal(sandboxFailureReason('x'.repeat(400)).length, 301);
});

test('one or two sandbox failures are retried by kubelet, not a build failure', () => {
  assert.equal(sandboxStartFailure([]), null);
  assert.equal(
    sandboxStartFailure([{ reason: 'FailedCreatePodSandBox', message: KATA, count: 2 }]),
    null
  );
  assert.equal(sandboxStartFailure([{ reason: 'Scheduled', message: 'ok', count: 9 }]), null);
});

test('repeated failures give up with the reason, counting combined events', () => {
  const failure = sandboxStartFailure([
    { reason: 'Scheduled', message: 'ok' },
    { reason: 'FailedCreatePodSandBox', message: 'old' },
    { reason: 'FailedCreatePodSandBox', message: KATA, count: 5 }
  ]);
  assert.match(failure ?? '', /failed to start 6 times/);
  assert.match(failure ?? '', /virtio_fs_extra_args is not enabled$/);
});

test('names the annotation and runtime class the pod carries', () => {
  const pod = { runtimeClassName: 'kata-qemu', annotations: { [KATA_ANNOTATION]: 'size=8G' } };
  const failure = sandboxStartFailure(
    [{ reason: 'FailedCreatePodSandBox', message: KATA, count: 3 }],
    pod
  );
  assert.match(failure ?? '', /failed to start 3 times/);
  assert.ok(failure?.includes(`pod annotation ${KATA_ANNOTATION}, runtime class kata-qemu`));
  assert.match(failure ?? '', /Orchard does not set it/);
});

test('reads a quoted annotation name', () => {
  assert.equal(
    sandboxPodDetail(`annotation "${KATA_ANNOTATION}" is not enabled`, {
      annotations: { [KATA_ANNOTATION]: '' }
    }),
    ` (pod annotation ${KATA_ANNOTATION}; Orchard does not set it, so something else in the cluster injects it)`
  );
});

test('stays quiet when the pod does not explain the failure', () => {
  assert.equal(
    sandboxPodDetail('no runtime for "kata" is configured', { runtimeClassName: 'kata' }),
    ''
  );
  assert.equal(sandboxPodDetail(KATA, null), '');
  assert.equal(sandboxPodDetail(KATA, { annotations: {} }), '');
  assert.equal(sandboxPodDetail(KATA, { annotations: { other: 'x' } }), '');
});
