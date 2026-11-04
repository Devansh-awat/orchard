import assert from 'node:assert/strict';
import test from 'node:test';
import { composeVolumeName } from '../src/compose-stacks/compose-volume-name';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

test('a name Kubernetes already accepts is kept, so existing claims stay attached', () => {
  assert.equal(composeVolumeName('data'), 'data');
  assert.equal(composeVolumeName('db-data'), 'db-data');
});

test('an invalid name becomes a valid one, the same one every time', () => {
  const name = composeVolumeName('db_data');
  assert.match(name, DNS_LABEL);
  assert.match(name, /^db-data-[0-9a-f]{8}$/);
  assert.equal(composeVolumeName('db_data'), name);
});

test('names that would slug the same stay apart', () => {
  const names = ['db-data', 'db_data', 'db.data', 'DB_DATA', 'Db_Data'].map(composeVolumeName);
  assert.equal(new Set(names).size, names.length);
});

test('every shape of name stays a DNS label within the length limit', () => {
  for (const raw of ['_data_', '___', 'a'.repeat(80), `${'a'.repeat(54)}-_b`, 'UPPER', '9.9']) {
    const name = composeVolumeName(raw);
    assert.match(name, DNS_LABEL, raw);
    assert.ok(name.length <= 63, raw);
  }
});
