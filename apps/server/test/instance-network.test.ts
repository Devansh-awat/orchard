import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedHostnames, WILDCARD_PROBE_LABEL } from '../src/instance-network/hostnames';
import { DnsCheckService } from '../src/instance-network/dns-check.service';

const noConfig = { value: () => null, isConfigured: () => false } as any;

test('every hostname the instance serves is derived from what it already knows', () => {
  const rows = expectedHostnames({
    frontendUrl: 'https://orchard.example.com',
    appDomain: 'apps.example.com',
    mcpUrl: 'https://mcp.example.com',
  });
  assert.deepEqual(
    rows.map((r) => r.record),
    ['orchard.example.com', '*.apps.example.com', 'mcp.example.com'],
  );
});

// `*.apps.example.com` is not a resolvable name, and checking one deployed
// app's hostname would pass on an instance whose wildcard is missing but which
// happens to have a single record for that app.
test('the wildcard is checked with a probe label no app URL can produce', () => {
  const [row] = expectedHostnames({ appDomain: 'apps.example.com' });
  assert.equal(row.record, '*.apps.example.com');
  assert.equal(row.probe, `${WILDCARD_PROBE_LABEL}.apps.example.com`);
  // A generated host ends in a 6-character hex hash. The probe's last segment
  // is neither, so no deployment can ever be given this name.
  const tail = WILDCARD_PROBE_LABEL.split('-').pop() as string;
  assert.equal(/^[0-9a-f]{6}$/.test(tail), false);
});

test('a leading wildcard or dot on the app domain is not doubled up', () => {
  for (const appDomain of ['apps.example.com', '.apps.example.com', '*.apps.example.com']) {
    const [row] = expectedHostnames({ appDomain });
    assert.equal(row.record, '*.apps.example.com', `for ${appDomain}`);
  }
});

test('nothing is expected for a hostname that is not configured', () => {
  assert.deepEqual(expectedHostnames({}), []);
  assert.deepEqual(
    expectedHostnames({ frontendUrl: 'https://orchard.example.com' }).map((r) => r.role),
    ['platform'],
  );
});

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// The comparison is against the dashboard rather than a configured IP: a pod
// cannot discover its own public address, and does not need to.
test('a name resolving somewhere other than the dashboard is reported but not failed', async () => {
  const service = new DnsCheckService(noConfig);
  await withEnv(
    {
      FRONTEND_URL: 'https://orchard.example.com',
      APP_DOMAIN: 'apps.example.com',
      MCP_BASE_URL: 'https://mcp.example.com',
    },
    async () => {
      (service as any).resolve = async (host: string) => {
        if (host === 'orchard.example.com') return ['203.0.113.10'];
        if (host.startsWith(WILDCARD_PROBE_LABEL)) return ['203.0.113.10'];
        return ['198.51.100.1'];
      };

      const report = await service.report(true);
      const verdicts = Object.fromEntries(report.rows.map((r) => [r.role, r.verdict]));
      assert.deepEqual(verdicts, { platform: 'ok', apps: 'ok', mcp: 'different' });
      assert.deepEqual(report.reference, ['203.0.113.10']);
      // Behind a proxy or CDN this is the normal state, so it must never put a
      // permanent warning badge on an instance that works.
      assert.equal(await service.allResolve(), true);
    },
  );
});

test('a name with no record reads as missing', async () => {
  const service = new DnsCheckService(noConfig);
  await withEnv(
    { FRONTEND_URL: 'https://orchard.example.com', APP_DOMAIN: '', MCP_BASE_URL: 'https://mcp.example.com' },
    async () => {
      (service as any).resolve = async (host: string) => {
        if (host === 'orchard.example.com') return ['203.0.113.10'];
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOTFOUND';
        throw err;
      };

      const report = await service.report(true);
      const mcp = report.rows.find((r) => r.role === 'mcp');
      assert.equal(mcp?.verdict, 'missing');
      assert.match(mcp?.message ?? '', /No record found/);
    },
  );
});

test('everything pointing at the dashboard reads as done', async () => {
  const service = new DnsCheckService(noConfig);
  await withEnv(
    {
      FRONTEND_URL: 'https://orchard.example.com',
      APP_DOMAIN: 'apps.example.com',
      MCP_BASE_URL: 'https://mcp.example.com',
    },
    async () => {
      (service as any).resolve = async () => ['203.0.113.10'];
      await service.report(true);
      assert.equal(await service.allResolve(), true);
    },
  );
});

// An instance with no domain has nothing outstanding, so the checklist item
// must not sit there permanently unfinished.
test('an instance with no domain reports no rows rather than failures', async () => {
  const service = new DnsCheckService(noConfig);
  await withEnv({ FRONTEND_URL: '', APP_DOMAIN: '', MCP_BASE_URL: '' }, async () => {
    const report = await service.report(true);
    assert.deepEqual(report.rows, []);
    assert.equal(await service.allResolve(), false);
  });
});

// The checklist counts only missing records, so an instance behind a proxy and
// an instance with no domain both read as finished rather than nagging forever.
test('only a missing record is outstanding', async () => {
  const service = new DnsCheckService(noConfig);
  await withEnv(
    {
      FRONTEND_URL: 'https://orchard.example.com',
      APP_DOMAIN: 'apps.example.com',
      MCP_BASE_URL: 'https://mcp.example.com',
    },
    async () => {
      (service as any).resolve = async (host: string) => {
        if (host === 'mcp.example.com') {
          const err: NodeJS.ErrnoException = new Error('nope');
          err.code = 'ENOTFOUND';
          throw err;
        }
        if (host === 'orchard.example.com') return ['203.0.113.10'];
        return ['198.51.100.1'];
      };

      const report = await service.report(true);
      const outstanding = DnsCheckService.outstanding(report);
      assert.deepEqual(outstanding.map((r) => r.record), ['mcp.example.com']);
    },
  );

  assert.deepEqual(DnsCheckService.outstanding(null), []);
  assert.deepEqual(DnsCheckService.outstanding({ checkedAt: '', reference: [], rows: [] }), []);
});
