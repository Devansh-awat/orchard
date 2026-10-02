import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackupEndpoint } from '../src/organizations/organizations.service';

test('a backup endpoint keeps its scheme and loses the trailing slash', () => {
  assert.equal(
    normalizeBackupEndpoint('https://acct.r2.cloudflarestorage.com/'),
    'https://acct.r2.cloudflarestorage.com'
  );
  assert.equal(
    normalizeBackupEndpoint('http://r2-proxy.ns.svc.cluster.local:9000'),
    'http://r2-proxy.ns.svc.cluster.local:9000'
  );
  assert.equal(normalizeBackupEndpoint('  '), null);
  assert.equal(normalizeBackupEndpoint(null), null);
});

test('a bare account id or a hostless URL is rejected', () => {
  for (const bad of [
    'https://65928e7e7265894b499567219490de12/',
    '65928e7e7265894b499567219490de12.r2.cloudflarestorage.com',
    'ftp://acct.r2.cloudflarestorage.com',
    'https://acct.r2.cloudflarestorage.com/?x=1'
  ]) {
    assert.throws(() => normalizeBackupEndpoint(bad), /full URL/);
  }
});
