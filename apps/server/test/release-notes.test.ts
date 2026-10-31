import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLatest, updatesBase } from '../src/updates/release-notes';

test('latest.json names a version and the note file next to it', () => {
  assert.deepEqual(parseLatest({ version: '3.0.0', publishedAt: '2026-10-31T00:00:00Z' }), {
    version: '3.0.0',
    file: '3.0.0.md',
    publishedAt: '2026-10-31T00:00:00Z',
    url: null
  });
  assert.equal(parseLatest({ version: '3.0.0', file: '3.0.0.md' })?.file, '3.0.0.md');
});

test('anything that is not a plain version or a plain note file is ignored', () => {
  assert.equal(parseLatest(null), null);
  assert.equal(parseLatest({ version: 'v3' }), null);
  assert.equal(parseLatest({ version: '3.0.0', file: '../../etc/passwd' })?.file, '3.0.0.md');
});

test('self-hosted instances can point elsewhere or turn it off', () => {
  assert.equal(updatesBase({}), 'https://assets.orchard.my/updates/ui');
  assert.equal(
    updatesBase({ UPDATES_URL: 'https://notes.example.com/ui/' }),
    'https://notes.example.com/ui'
  );
  assert.equal(updatesBase({ UPDATES_URL: 'off' }), null);
});
