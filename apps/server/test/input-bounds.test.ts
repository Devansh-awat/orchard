import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRootDirectory } from '../src/docker/build-config';
import { resolveIssuerUrl } from '../src/sso/presets';

const BUDGET_MS = 250;

function elapsed(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test('normalizeRootDirectory does not stall on a body-sized run of slashes', () => {
  const payload = '/'.repeat(25_000_000);
  const ms = elapsed(() => assert.equal(normalizeRootDirectory(payload), null));
  assert.ok(ms < BUDGET_MS, `took ${ms}ms`);
});

test('resolveIssuerUrl does not stall on a body-sized run of slashes', () => {
  const payload = '/'.repeat(25_000_000);
  const preset = { id: 'x', issuerTemplate: 'https://{domain}/x' } as never;

  const issuerMs = elapsed(() => resolveIssuerUrl(null, { issuerUrl: payload }));
  assert.ok(issuerMs < BUDGET_MS, `issuerUrl took ${issuerMs}ms`);

  const domainMs = elapsed(() => resolveIssuerUrl(preset, { domain: payload }));
  assert.ok(domainMs < BUDGET_MS, `domain took ${domainMs}ms`);
});

test('normalizeRootDirectory still normalizes the shapes callers rely on', () => {
  assert.equal(normalizeRootDirectory('apps/server/'), 'apps/server');
  assert.equal(normalizeRootDirectory('./src'), 'src');
  assert.equal(normalizeRootDirectory('src///'), 'src');
  assert.equal(normalizeRootDirectory('.'), null);
  assert.equal(normalizeRootDirectory(''), null);
  assert.equal(normalizeRootDirectory('../etc'), null);
  assert.equal(normalizeRootDirectory('a/../b'), null);
  assert.equal(normalizeRootDirectory('/abs'), null);
});

test('resolveIssuerUrl still trims trailing slashes and strips the scheme', () => {
  assert.equal(
    resolveIssuerUrl(null, { issuerUrl: 'https://idp.example.com/auth///' }),
    'https://idp.example.com/auth',
  );
  assert.equal(
    resolveIssuerUrl({ id: 'x', issuerTemplate: 'https://{domain}/x' } as never, {
      domain: 'https://acme.com/',
    }),
    'https://acme.com/x',
  );
});

test('a repo or file name arriving as an array is rejected, not coerced', async () => {
  const { SandboxWorkspaceService } = await import('../src/sandboxes/sandbox-workspace.service');
  const svc = new SandboxWorkspaceService(null as never, null as never);

  // Array.prototype.includes('..') is an exact-element match, so the traversal
  // guard used to pass for a single-element array whose content held '..'.
  assert.throws(
    () => svc.resolveWorkdir({ repoUrl: null }, ['a/../../etc'] as never),
    /Invalid repo name/,
  );
  assert.equal(svc.resolveWorkdir({ repoUrl: null }, 'myrepo'), '/persist/home/myrepo');
});
