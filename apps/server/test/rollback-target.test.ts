import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPreviousImage } from '../src/projects/rollback-target';

const at = (n: number) => new Date(Date.UTC(2026, 9, n));

test('picks the newest older image that differs from the active one', () => {
  const history = [
    { id: 'v3', image: 'app:3', isActive: true, createdAt: at(3) },
    { id: 'v2', image: 'app:2', isActive: false, createdAt: at(2) },
    { id: 'v1', image: 'app:1', isActive: false, createdAt: at(1) }
  ];
  assert.equal(pickPreviousImage(history, 'app:3')?.id, 'v2');
});

test('after a rollback, previous walks further back instead of forward', () => {
  const history = [
    { id: 'v3', image: 'app:3', isActive: false, createdAt: at(3) },
    { id: 'v2', image: 'app:2', isActive: true, createdAt: at(2) },
    { id: 'v1', image: 'app:1', isActive: false, createdAt: at(1) }
  ];
  assert.equal(pickPreviousImage(history, 'app:2')?.id, 'v1');
});

test('skips rebuilds of the same image', () => {
  const history = [
    { id: 'b', image: 'app:2', isActive: true, createdAt: at(3) },
    { id: 'a', image: 'app:2', isActive: false, createdAt: at(2) },
    { id: 'v1', image: 'app:1', isActive: false, createdAt: at(1) }
  ];
  assert.equal(pickPreviousImage(history, 'app:2')?.id, 'v1');
});

test('falls back to the deployment image when nothing is marked active', () => {
  const history = [
    { id: 'v2', image: 'app:2', isActive: false, createdAt: at(2) },
    { id: 'v1', image: 'app:1', isActive: false, createdAt: at(1) }
  ];
  assert.equal(pickPreviousImage(history, 'app:2')?.id, 'v1');
});

test('returns null when there is nothing to roll back to', () => {
  assert.equal(pickPreviousImage([], 'app:1'), null);
  assert.equal(
    pickPreviousImage([{ id: 'v1', image: 'app:1', isActive: true, createdAt: at(1) }], 'app:1'),
    null
  );
});
