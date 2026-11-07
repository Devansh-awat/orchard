import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assetKey } from '../src/projects/favicon.service';

test('favicon and banner keys do not expose the hostname', () => {
  const key = assetKey('favicons', 'secret-app.example.com');
  assert.match(key, /^favicons\/[0-9a-f]{32}\.png$/);
  assert.ok(!key.includes('secret-app'));
  assert.equal(assetKey('favicons', 'Secret-App.example.com'), key);
  assert.notEqual(
    assetKey('banners', 'secret-app.example.com'),
    key.replace('favicons', 'banners')
  );
});

test('the vector daemonset admits no ingress, so its API is unreachable from tenants', () => {
  const logs = readFileSync(
    resolve(__dirname, '../../../infra/charts/orchard/templates/logs.yaml'),
    'utf8'
  );
  assert.match(
    logs,
    /kind: NetworkPolicy\nmetadata:\n  name: vector-no-ingress[\s\S]*?matchLabels:\n      app: vector\n  policyTypes: \[Ingress\]\n  ingress: \[\]/
  );
});
