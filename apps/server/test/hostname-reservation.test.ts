import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  isReservedHost,
  isReservedSubdomainLabel,
  normalizeHost,
  lockHostnameClaims
} from '../src/instance-network/reserved-hosts';
import { VanityDomainService } from '../src/sso/vanity-domain.service';
import { StatusPagesService } from '../src/status-pages/status-pages.service';
import { ProjectAccessService } from '../src/projects/project-access.service';

const KEYS = [
  'BASE_DOMAIN',
  'FRONTEND_URL',
  'MCP_BASE_URL',
  'BACKEND_URL',
  'ORCHARD_DOCS_URL',
  'RESERVED_HOSTS',
  'RESERVED_HOST_SUFFIXES',
  'REGISTRY_HTTP_HOSTS'
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function platformEnv() {
  process.env.BASE_DOMAIN = 'orchard.my';
  process.env.FRONTEND_URL = 'https://dash.orchard.my';
  process.env.MCP_BASE_URL = 'https://tools.orchard.my/mcp';
  process.env.BACKEND_URL = 'https://backend-edge.orchard.my';
  process.env.ORCHARD_DOCS_URL = 'https://manual.orchard.my';
  process.env.REGISTRY_HTTP_HOSTS = 'cr.orchard.my:5000';
  process.env.RESERVED_HOSTS = 'Extra.Orchard.My, ';
}

test('normalizeHost folds case, whitespace, trailing dots, ports, urls and IDN', () => {
  assert.equal(normalizeHost('  MCP.Orchard.My. '), 'mcp.orchard.my');
  assert.equal(normalizeHost('https://Tools.Orchard.My:8443/x'), 'tools.orchard.my');
  assert.equal(normalizeHost('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeHost('xn--bcher-kva.example..'), 'xn--bcher-kva.example');
  assert.equal(normalizeHost(''), '');
});

test('every platform host from the environment is reserved, however it is spelled', () => {
  platformEnv();
  for (const label of [
    'dash',
    'tools',
    'TOOLS',
    ' tools ',
    'tools.',
    'backend-edge',
    'manual',
    'cr',
    'extra'
  ]) {
    assert.equal(isReservedSubdomainLabel(label, 'orchard.my'), true, label);
  }
  assert.equal(isReservedHost('Tools.Orchard.My.'), true);
  assert.equal(isReservedHost('shop.orchard.my'), false);
  assert.equal(isReservedSubdomainLabel('acme', 'orchard.my'), false);
});

test('suffix reservations apply to deeper zones but never swallow the vanity zone itself', () => {
  process.env.RESERVED_HOST_SUFFIXES = '.orchard.my, internal.orchard.my';
  assert.equal(isReservedHost('a.b.internal.orchard.my'), true);
  assert.equal(isReservedHost('shop.orchard.my'), true);
  assert.equal(isReservedSubdomainLabel('acme', 'orchard.my'), false);
  assert.equal(isReservedSubdomainLabel('internal', 'orchard.my'), true);
});

test('the static reserved labels cover mcp and registry', () => {
  assert.equal(isReservedSubdomainLabel('mcp', 'orchard.my'), true);
  assert.equal(isReservedSubdomainLabel('registry', 'orchard.my'), true);
});

interface State {
  orgs: string[];
  pages: string[];
  locks: number;
  updates: string[];
}

function fakePrisma(state: State) {
  const db: any = {
    $executeRaw: async () => {
      state.locks++;
      return 0;
    },
    organization: {
      findUnique: async ({ where }: any) =>
        where.subdomain && state.orgs.includes(where.subdomain) ? { id: 'other' } : null,
      findFirst: async () => null,
      update: async ({ data }: any) => {
        state.updates.push(data.subdomain);
        return { id: 'o1', subdomain: data.subdomain };
      }
    },
    statusPage: {
      findUnique: async ({ where }: any) =>
        state.pages.includes(where.subdomain) ? { id: 'p-other' } : null,
      create: async ({ data }: any) => {
        state.updates.push(data.subdomain);
        return { id: 'p1', ...data };
      },
      update: async ({ data }: any) => ({ id: 'p1', ...data })
    },
    ingress: { findFirst: async () => null },
    $transaction: async (fn: any) => fn(db)
  };
  return db;
}

function fresh(): State {
  return { orgs: [], pages: [], locks: 0, updates: [] };
}

function vanity(state: State) {
  const svc = Object.create(VanityDomainService.prototype) as any;
  svc.prisma = fakePrisma(state);
  svc.baseDomain = 'orchard.my';
  svc.platformNamespace = 'default';
  svc.logger = { log() {}, error() {}, warn() {} };
  svc.k8sNetwork = { createIngress: async () => {}, updateIngress: async () => {} };
  return svc;
}

test('an org owner cannot claim a platform hostname as a vanity subdomain', async () => {
  platformEnv();
  const state = fresh();
  for (const label of [
    'tools',
    'Tools',
    ' TOOLS ',
    'backend-edge',
    'manual',
    'cr',
    'extra',
    'dash'
  ]) {
    await assert.rejects(vanity(state).setSubdomain('o1', label), BadRequestException, label);
  }
  assert.deepEqual(state.updates, []);
});

test('a free vanity subdomain is claimed under the claims lock', async () => {
  platformEnv();
  const state = fresh();
  await vanity(state).setSubdomain('o1', 'Acme');
  assert.deepEqual(state.updates, ['acme']);
  assert.equal(state.locks, 1);
});

test('a lost unique-index race on the vanity subdomain surfaces as a conflict', async () => {
  platformEnv();
  const svc = vanity(fresh());
  svc.prisma.organization.update = async () => {
    throw Object.assign(new Error('unique'), { code: 'P2002' });
  };
  await assert.rejects(svc.setSubdomain('o1', 'acme'), ConflictException);
});

function statusPages(state: State) {
  const svc = Object.create(StatusPagesService.prototype) as any;
  svc.prisma = fakePrisma(state);
  svc.baseDomain = 'orchard.my';
  svc.platformNamespace = 'default';
  svc.logger = { log() {}, error() {}, warn() {} };
  svc.k8sNetwork = { createIngress: async () => {}, updateIngress: async () => {} };
  svc.audit = { log: async () => {}, diff: () => ({}) };
  svc.cache = new Map();
  return svc;
}

test('a status page cannot claim a platform hostname', () => {
  platformEnv();
  const svc = statusPages(fresh());
  for (const label of ['tools', 'TOOLS', 'backend-edge', 'manual', 'cr', 'mcp', 'dash']) {
    assert.throws(() => svc.checkSubdomainShape(label), BadRequestException, label);
  }
  assert.equal(svc.checkSubdomainShape('Acme-Status'), 'acme-status');
});

test('status page claims lock and reject names another org or page holds', async () => {
  platformEnv();
  const state = { ...fresh(), orgs: ['taken'], pages: ['also-taken'] };
  const svc = statusPages(state);
  await assert.rejects(
    svc.withClaimedSubdomain('taken', null, async () => 1),
    ConflictException
  );
  await assert.rejects(
    svc.withClaimedSubdomain('also-taken', null, async () => 1),
    ConflictException
  );
  assert.equal(await svc.withClaimedSubdomain('free-one', null, async () => 7), 7);
  assert.equal(state.locks, 3);
});

test('custom domains share the same reservation, including spelling variants', async () => {
  platformEnv();
  const svc = Object.create(ProjectAccessService.prototype) as any;
  svc.prisma = fakePrisma(fresh());
  svc.instanceSettings = { isCustomDomainVerificationRequired: async () => false };
  for (const host of ['TOOLS.orchard.my.', ' backend-edge.orchard.my', 'manual.orchard.my']) {
    await assert.rejects(svc.assertHostnameAvailable(host, 'p1'), ConflictException, host);
  }
});

test('lockHostnameClaims takes a transaction-scoped advisory lock', async () => {
  let sql = '';
  await lockHostnameClaims({
    $executeRaw: async (q: TemplateStringsArray) => {
      sql = q.join('?');
      return 0;
    }
  });
  assert.match(sql, /pg_advisory_xact_lock/);
});
