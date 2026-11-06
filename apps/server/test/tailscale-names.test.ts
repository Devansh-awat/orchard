import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTailscaleOwned,
  legacyTailscaleNames,
  tailscaleNames
} from '../src/kubernetes/tailscale-names';
import { tailscaleRoleRules } from '../src/kubernetes/tailscale-rbac';
import { formatSlug } from '../src/projects/projects.utils';
import { assertIngressNameFree, isPlatformGeneratedName } from '../src/projects/image-ownership';

test('tailscale object names cannot be produced by a tenant app name', () => {
  for (const app of ['bar-env', 'a', 'x'.repeat(60), 'ts-auth-bar']) {
    for (const name of Object.values(tailscaleNames(app))) {
      assert.ok(name.includes('--'), name);
      assert.ok(name.length <= 63, name);
      assert.notEqual(formatSlug(name), name);
    }
  }
});

test('the old collision (ts-auth-<app> vs <other>-env) no longer overlaps', () => {
  const victim = tailscaleNames('bar-env');
  assert.equal(legacyTailscaleNames('bar-env').keySecret, 'ts-auth-bar-env');
  assert.notEqual(victim.keySecret, 'ts-auth-bar-env');
  assert.notEqual(victim.stateSecret, 'ts-auth-bar-env');
  assert.notEqual(victim.proxy, 'ts-bar-env');
});

test('long app names get distinct, bounded names', () => {
  const a = tailscaleNames('x'.repeat(59) + 'a').keySecret;
  const b = tailscaleNames('x'.repeat(59) + 'b').keySecret;
  assert.notEqual(a, b);
  assert.ok(a.length <= 63 && b.length <= 63);
});

test('the proxy role only reaches its state secret by name', () => {
  const rules = tailscaleRoleRules('ts--state--foo');
  const secretRules = rules.filter((r) => r.resources?.includes('secrets'));
  assert.ok(secretRules.length > 0);
  for (const r of secretRules) {
    assert.deepEqual(r.resourceNames, ['ts--state--foo']);
    assert.ok(!r.verbs?.includes('create') && !r.verbs?.includes('list'));
  }
});

test('ownership labels gate legacy object handling', () => {
  const owned = { labels: { 'orchard.my/tailscale': 'true', 'orchard.my/target-deployment': 'a' } };
  assert.equal(isTailscaleOwned(owned, 'a'), true);
  assert.equal(isTailscaleOwned(owned, 'b'), false);
  assert.equal(isTailscaleOwned({ labels: { 'app.kubernetes.io/name': 'a' } }, 'a'), false);
  assert.equal(isTailscaleOwned(undefined), false);
});

test('app names that mimic platform-generated object names are rejected', async () => {
  for (const n of ['ts--x', 'foo-pub-t80', 'foo-pub-u53', 'foo-allow-public']) {
    assert.equal(isPlatformGeneratedName(n), true, n);
    await assert.rejects(() => assertIngressNameFree({} as never, 'ns', n, 'p'));
  }
  assert.equal(isPlatformGeneratedName('my-app'), false);
});
