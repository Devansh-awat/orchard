import { domainToASCII } from 'node:url';

const RESERVED_LABELS = new Set([
  'www',
  'api',
  'admin',
  'mail',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'ssh',
  'ns1',
  'ns2',
  'cdn',
  'app',
  'dashboard',
  'login',
  'auth',
  'status',
  'docs',
  'help',
  'support',
  'billing',
  'blog',
  'mcp',
  'registry',
  'assets',
  'git',
  'scim',
  'oauth',
  'sso',
  'grafts',
  'marketplace',
  'templates'
]);

const URL_ENV_KEYS = [
  'FRONTEND_URL',
  'MCP_BASE_URL',
  'BACKEND_URL',
  'ORCHARD_API_URL',
  'ORCHARD_DOCS_URL',
  'SCIM_BASE_URL',
  'EMAIL_ASSET_BASE_URL',
  'TEMPLATE_REGISTRY_URL',
  'ORCHARD_GRAFT_MARKETPLACE_URL'
];

const LIST_ENV_KEYS = ['RESERVED_HOSTS', 'REGISTRY_HTTP_HOSTS'];

export function normalizeHost(raw: string | null | undefined): string {
  let value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
    }
  }
  value = value.replace(/\.+$/, '').replace(/^\.+/, '');
  if (value.startsWith('[') || (value.match(/:/g) ?? []).length > 1) return value;
  value = value.replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!value) return '';
  return domainToASCII(value) || value;
}

function normalizeSuffix(raw: string): string {
  return normalizeHost(raw.trim().replace(/^\*?\./, ''));
}

export function reservedHostSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const key of URL_ENV_KEYS) {
    const host = normalizeHost(env[key]);
    if (host) hosts.add(host);
  }
  for (const key of LIST_ENV_KEYS) {
    for (const entry of (env[key] || '').split(',')) {
      const host = normalizeHost(entry);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

export function reservedSuffixList(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RESERVED_HOST_SUFFIXES || '')
    .split(',')
    .map((s) => normalizeSuffix(s))
    .filter(Boolean);
}

export interface ReservedHostOptions {
  env?: NodeJS.ProcessEnv;
  withinZone?: string;
}

export function isReservedHost(rawHost: string, options: ReservedHostOptions = {}): boolean {
  const env = options.env ?? process.env;
  const host = normalizeHost(rawHost);
  if (!host) return true;
  if (reservedHostSet(env).has(host)) return true;
  const zone = options.withinZone ? normalizeHost(options.withinZone) : '';
  for (const suffix of reservedSuffixList(env)) {
    if (zone && (zone === suffix || zone.endsWith(`.${suffix}`))) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

export function isReservedSubdomainLabel(
  rawLabel: string,
  baseDomain: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const label = normalizeHost(rawLabel);
  if (!label || label.includes('.')) return true;
  if (RESERVED_LABELS.has(label)) return true;
  const zone = normalizeHost(baseDomain);
  if (!zone) return false;
  return isReservedHost(`${label}.${zone}`, { env, withinZone: zone });
}

export const HOSTNAME_CLAIMS_LOCK_KEY = 'orchard:hostname-claims';

interface RawExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export async function lockHostnameClaims(tx: RawExecutor): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${HOSTNAME_CLAIMS_LOCK_KEY}, 0))`;
}
