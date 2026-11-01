import test from 'node:test';
import assert from 'node:assert/strict';
import { readSystemInfo } from '../src/security/harbor-scan.client';
import { SecurityService } from '../src/security/security.service';

test('only a systeminfo answer with a harbor version counts as Harbor', () => {
  const base = 'https://registry.example.com';
  assert.deepEqual(readSystemInfo(200, { harbor_version: 'v2.11.0' }, base), {
    harbor: true,
    reason: null,
    transient: false
  });
  const zot = readSystemInfo(404, null, base);
  assert.equal(zot.harbor, false);
  assert.ok(!zot.transient && zot.reason?.includes('not Harbor'));
  assert.equal(readSystemInfo(200, { version: '1' }, base).harbor, false);
  assert.equal(readSystemInfo(401, null, base).harbor, false);
  const down = readSystemInfo(503, null, base);
  assert.ok(!down.harbor && down.transient);
});

function security(opts: { trivy: boolean; harborConfigured: boolean; harbor: boolean }) {
  const harbor = {
    configured: opts.harborConfigured,
    registryConfig: { registries: [], project: 'orchard' },
    detect: async () =>
      opts.harbor
        ? { harbor: true, reason: null, transient: false }
        : { harbor: false, reason: 'The registry is not Harbor', transient: false }
  };
  const trivy = {
    configured: opts.trivy,
    unavailableReason: () => (opts.trivy ? null : 'TRIVY_SERVER_URL is not set.')
  };
  return new SecurityService({} as any, harbor as any, trivy as any, {} as any);
}

test('the default scanner prefers trivy, then a real Harbor, then off', async () => {
  assert.equal(
    await security({ trivy: true, harborConfigured: true, harbor: true }).defaultScanner(),
    'trivy'
  );
  assert.equal(
    await security({ trivy: false, harborConfigured: true, harbor: true }).defaultScanner(),
    'harbor'
  );
  assert.equal(
    await security({ trivy: false, harborConfigured: true, harbor: false }).defaultScanner(),
    'off'
  );
  assert.equal(
    await security({ trivy: false, harborConfigured: false, harbor: true }).defaultScanner(),
    'off'
  );
});

test('a zot registry with harbor credentials does not offer Harbor', async () => {
  const options = await security({
    trivy: false,
    harborConfigured: true,
    harbor: false
  }).scannerOptions();
  const harbor = options.find((o) => o.value === 'harbor');
  assert.equal(harbor?.available, false);
  assert.equal(harbor?.reason, 'The registry is not Harbor');
});
