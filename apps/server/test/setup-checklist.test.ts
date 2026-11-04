import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SetupService } from '../src/setup/setup.service';

const NAMES = [
  'INSTALL_INGRESS_MODE',
  'TENANT_RUNTIME_CLASS',
  'TRIVY_SERVER_URL',
  'HARBOR_API_URL',
  'MCP_ENABLED',
  'IMAGE_SCANNER'
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function checklist(
  opts: {
    publicIp?: string;
    users?: number;
    mcpEnv?: boolean | null;
    scanner?: { value: string; dbValue: string | null };
  } = {}
) {
  const svc = Object.create(SetupService.prototype) as any;
  svc.logger = { warn() {}, error() {} };
  svc.githubApp = { isConfigured: () => false };
  svc.dns = { report: async () => null };
  svc.config = {
    isConfigured: () => false,
    defaultPublicIp: () => opts.publicIp ?? '',
    value: () => null
  };
  svc.settings = {
    getMcpState: async () => ({
      enabled: opts.mcpEnv !== false,
      dbValue: true,
      envOverride: opts.mcpEnv ?? null
    }),
    getImageScannerState: async (fallback: () => Promise<string>) =>
      opts.scanner ?? { value: await fallback(), dbValue: null, envOverride: null }
  };
  svc.prisma = {
    identityProvider: { count: async () => 0 },
    user: { count: async () => opts.users ?? 1 }
  };
  return (svc as SetupService).getChecklist();
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const quiet = { scanner: { value: 'trivy', dbValue: null } };

test('an instance with nothing to do gets none of the conditional items', async () => {
  process.env.INSTALL_INGRESS_MODE = 'public';
  const items = await checklist({ ...quiet, publicIp: '203.0.113.10' });
  for (const id of ['public-ip', 'mcp', 'image-scanning', 'tenant-isolation']) {
    assert.ok(!ids(items).includes(id), id);
  }
});

test('production-shaped config adds nothing', async () => {
  process.env.TENANT_RUNTIME_CLASS = 'gvisor';
  const items = await checklist({
    users: 500,
    scanner: { value: 'harbor', dbValue: null }
  });
  assert.deepEqual(ids(items), [
    'github-app',
    'backups',
    'smtp',
    'oidc',
    'ingress-cname',
    'dns',
    'wildcard-tls'
  ]);
});

test('the public IP item appears only where public ports can exist and none is set', async () => {
  process.env.INSTALL_INGRESS_MODE = 'public';
  assert.ok(ids(await checklist(quiet)).includes('public-ip'));
  process.env.INSTALL_INGRESS_MODE = 'lan';
  assert.ok(ids(await checklist(quiet)).includes('public-ip'));
  process.env.INSTALL_INGRESS_MODE = 'tunnel';
  assert.ok(!ids(await checklist(quiet)).includes('public-ip'));
});

test('the MCP item appears when the deployment has it off', async () => {
  assert.ok(ids(await checklist({ ...quiet, mcpEnv: false })).includes('mcp'));
  assert.ok(!ids(await checklist({ ...quiet, mcpEnv: null })).includes('mcp'));
});

test('image scanning is listed when nobody chose off and nothing is available', async () => {
  assert.ok(ids(await checklist()).includes('image-scanning'));
  process.env.TRIVY_SERVER_URL = 'http://trivy:8080';
  assert.ok(!ids(await checklist()).includes('image-scanning'));
  delete process.env.TRIVY_SERVER_URL;
  const chosen = await checklist({ scanner: { value: 'off', dbValue: 'off' } });
  assert.ok(!ids(chosen).includes('image-scanning'), 'a deliberate off is respected');
});

test('the kernel warning appears once a second person joins, until a sandbox is on', async () => {
  assert.ok(!ids(await checklist({ ...quiet, users: 1 })).includes('tenant-isolation'));
  const items = await checklist({ ...quiet, users: 2 });
  const item = items.find((i) => i.id === 'tenant-isolation');
  assert.equal(item?.title, "Apps share this server's kernel");
  assert.equal(item?.severity, 'warning');
  assert.equal(item?.href, 'https://docs.orchard.my/operate/security/');
  process.env.TENANT_RUNTIME_CLASS = 'gvisor';
  assert.ok(!ids(await checklist({ ...quiet, users: 2 })).includes('tenant-isolation'));
});

test('the GitHub App item warns about webhooks on a private network', async () => {
  const github = async () => (await checklist(quiet)).find((i) => i.id === 'github-app')?.detail;
  assert.ok(!/webhooks may not reach/.test((await github()) ?? ''));
  process.env.INSTALL_INGRESS_MODE = 'lan';
  assert.match((await github()) ?? '', /webhooks may not reach it/);
});
