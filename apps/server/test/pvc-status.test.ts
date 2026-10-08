import test from 'node:test';
import assert from 'node:assert/strict';
import { observePvc, storageShrinks } from '../src/kubernetes/pvc-status';

const pvc = (status: Record<string, unknown>, requested = '10Gi') =>
  ({
    spec: { resources: { requests: { storage: requested } } },
    status
  }) as any;

test('a bound claim at its requested size has nothing in flight', () => {
  const seen = observePvc(pvc({ phase: 'Bound', capacity: { storage: '10Gi' } }));
  assert.deepEqual(seen, {
    phase: 'Bound',
    requested: '10Gi',
    capacity: '10Gi',
    resizeState: null,
    message: null
  });
});

test('a request above the provisioned capacity reads as resizing even before a condition lands', () => {
  const seen = observePvc(pvc({ phase: 'Bound', capacity: { storage: '10Gi' } }, '20Gi'));
  assert.equal(seen.resizeState, 'resizing');
  assert.equal(seen.capacity, '10Gi');
});

test('a filesystem resize waiting on the pod is reported as pending a restart', () => {
  const seen = observePvc(
    pvc(
      {
        phase: 'Bound',
        capacity: { storage: '10Gi' },
        conditions: [
          {
            type: 'FileSystemResizePending',
            status: 'True',
            message: 'Waiting for user to (re-)start a pod'
          }
        ]
      },
      '20Gi'
    )
  );
  assert.equal(seen.resizeState, 'pendingRestart');
  assert.match(seen.message ?? '', /start a pod/);
});

test('allocatedResourceStatuses wins over the older conditions', () => {
  const failed = observePvc(
    pvc(
      {
        phase: 'Bound',
        capacity: { storage: '10Gi' },
        allocatedResourceStatuses: { storage: 'ControllerResizeFailed' },
        conditions: [{ type: 'Resizing', status: 'True', message: 'volume is attached' }]
      },
      '20Gi'
    )
  );
  assert.equal(failed.resizeState, 'failed');
  assert.equal(failed.message, 'volume is attached');

  const pending = observePvc(
    pvc({ phase: 'Bound', allocatedResourceStatuses: { storage: 'NodeResizePending' } }, '20Gi')
  );
  assert.equal(pending.resizeState, 'pendingRestart');
});

test('shrinking is detected across units and ignores unparseable sizes', () => {
  assert.equal(storageShrinks('20Gi', '5Gi'), true);
  assert.equal(storageShrinks('1Gi', '1024Mi'), false);
  assert.equal(storageShrinks('1Gi', '2Gi'), false);
  assert.equal(storageShrinks(null, '1Gi'), false);
  assert.equal(storageShrinks('garbage', '1Gi'), false);
});
