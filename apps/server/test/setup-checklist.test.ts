import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SetupService } from '../src/setup/setup.service';
import { setWildcardOverride } from '../src/projects/projects.utils';

const NAMES = [
  'INSTALL_INGRESS_MODE',
  'TENANT_RUNTIME_CLASS',
  'TRIVY_SERVER_URL',
  'HARBOR_API_URL',
  'MCP_ENABLED',
  'IMAGE_SCANNER',
  'MCP_BASE_URL',
  'FRONTEND_URL',
  'APP_DOMAIN'
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

function overview(
  opts: {
    installMode?: string;
    publicIp?: string;
    cname?: string;
    email?: boolean;
    skipped?: string[];
    mcpEnv?: boolean | null;
    mcpUrl?: string;
    cert?: { state: string; message?: string };
    github?: boolean;
  } = {}
) {
  if (opts.installMode) process.env.INSTALL_INGRESS_MODE = opts.installMode;
  if (opts.mcpUrl) process.env.MCP_BASE_URL = opts.mcpUrl;
  process.env.FRONTEND_URL = 'https://orchard.example.com';
  process.env.APP_DOMAIN = 'apps.example.com';
  setWildcardOverride(null, null);
  const svc = Object.create(SetupService.prototype) as any;
  svc.logger = { warn() {}, error() {} };
  svc.githubApp = { isConfigured: () => opts.github ?? false };
  svc.config = {
    fresh: async () => {},
    isConfigured: () => opts.email ?? false,
    defaultPublicIp: () => opts.publicIp ?? '',
    value: (_section: unknown, name: string) => (name === 'cname' ? (opts.cname ?? null) : null),
    lockedFields: () => []
  };
  svc.settings = {
    getMcpState: async () => ({
      enabled: opts.mcpEnv !== false,
      dbValue: true,
      envOverride: opts.mcpEnv ?? null
    }),
    getResourceLimitsState: async () => ({ value: 'on', dbValue: null, envOverride: null })
  };
  svc.network = {
    getCertificateStatus: async (namespace: string, secret: string) => {
      svc.asked = `${namespace}/${secret}`;
      return opts.cert ?? { state: 'ready' };
    }
  };
  svc.prisma = {
    user: { findUnique: async () => ({ setupSkipped: opts.skipped ?? [] }) }
  };
  return { svc, result: (svc as SetupService).getOverview('me') };
}

const item = (o: { items: { id: string; state: string; value: string }[] }, id: string) =>
  o.items.find((i) => i.id === id);

test('the overview says what is configured and what was skipped', async () => {
  const { result } = overview({
    installMode: 'public',
    publicIp: '203.0.113.10',
    cname: 'orchard.example.com',
    skipped: ['email', 'github'],
    mcpUrl: 'https://mcp.example.com'
  });
  const o = await result;
  assert.equal(o.installer, true);
  assert.equal(item(o, 'public-ip')?.state, 'configured');
  assert.equal(item(o, 'custom-domains')?.value, 'orchard.example.com');
  assert.equal(item(o, 'email')?.state, 'skipped');
  assert.equal(item(o, 'github')?.state, 'skipped');
  assert.equal(item(o, 'mcp')?.value, 'mcp.example.com');
  assert.equal(item(o, 'dashboard')?.value, 'orchard.example.com');
  assert.equal(item(o, 'apps')?.value, 'apps.example.com');
  assert.ok(o.mcp.deployed);
});

test('a public install reports the dashboard certificate, not per-host', async () => {
  const { svc, result } = overview({
    installMode: 'public',
    cert: { state: 'failed', message: 'Timeout during connect' }
  });
  const o = await result;
  assert.equal(svc.asked.endsWith('/orchard-tls'), true);
  assert.equal(o.certificate.state, 'failed');
  assert.equal(o.certificate.host, 'orchard.example.com');
  assert.equal(item(o, 'certificate')?.state, 'pending');
  assert.equal(item(o, 'certificate')?.value, 'Failed');
});

test('tunnel and lan installs have no certificate of their own to report', async () => {
  for (const installMode of ['tunnel', 'lan']) {
    const o = await overview({ installMode }).result;
    assert.equal(o.certificate.state, 'external');
    assert.equal(item(o, 'certificate'), undefined);
  }
});

test('a Helm install keeps per-host certificates and says the script did not run', async () => {
  const o = await overview({}).result;
  assert.equal(o.installer, false);
  assert.equal(o.mode, null);
  assert.equal(o.certificate.state, 'perHost');
  assert.equal(item(o, 'public-ip')?.state, 'pending');
});

test('the overview names the issuer and says when limits are pinned', async () => {
  process.env.CERT_CLUSTER_ISSUER = 'letsencrypt-prod';
  try {
    const o = await overview({}).result;
    assert.equal(o.certIssuer, 'letsencrypt-prod');
    assert.equal(o.locked.limits, false);
  } finally {
    delete process.env.CERT_CLUSTER_ISSUER;
  }
});

test('the MCP checklist item names the route that matches the install', async () => {
  const detail = async (installMode: string | undefined) => {
    const { svc } = overview({ installMode, mcpEnv: false });
    svc.settings.getImageScannerState = async () => ({ value: 'trivy', dbValue: null });
    svc.prisma.user.count = async () => 1;
    const items = await svc.conditionalChecklist(installMode ?? '');
    return items.find((i: { id: string }) => i.id === 'mcp')?.detail as string;
  };
  assert.match(await detail('public'), /sudo orchardctl mcp enable/);
  const helm = await detail(undefined);
  assert.doesNotMatch(helm, /orchardctl/);
  assert.match(helm, /Helm values/);
});

test('an MCP the chart did not deploy reads as off', async () => {
  const o = await overview({ mcpEnv: false }).result;
  assert.equal(o.mcp.deployed, false);
  assert.equal(item(o, 'mcp')?.state, 'off');
});
