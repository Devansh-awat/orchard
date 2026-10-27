import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
/**
 * Pure helpers shared between ProjectsService, DatabasesService and friends.
 * Kept dependency-free so any service in the projects module can import them
 * without dragging in DI.
 */

export function wildcardSecretNameFor(suffix: string): string {
  return `wildcard-${suffix
    .replace(/^\./, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()}-tls`;
}

// Suffixes Orchard hands out automatically at create time. A host under one of
// these is the generated URL, not a domain anybody chose, which is how we tell
// "has a URL" from "has a custom domain". Explicit PLATFORM_WILDCARD_DOMAINS
// wins; otherwise a single entry is derived from APP_DOMAIN. There is no
// literal fallback: an unconfigured instance must not mint URLs under a domain
// it doesn't own.
//
// `secret` is the wildcard TLS Secret to reuse for hosts under the suffix, and
// it is null unless the operator named one. Synthesising a name here was a bug:
// nothing creates that Secret on an install without a DNS-01 issuer and a way
// to copy it into every tenant namespace, so every generated URL pointed at a
// Secret that never existed and served no certificate. With null, callers fall
// through to per-host issuance against CERT_CLUSTER_ISSUER, which works out of
// the box. See docs/self-hosting.md for the wildcard upgrade path.
//
// Parsed here rather than in ingress.service so deployments.service can use it:
// ingress.service already forwardRef-imports DeploymentsService, and importing
// back the other way is the circular dependency that TDZ-crashes boot under swc.
// Set by InstanceConfigService when stored config loads or changes. A plain
// module variable rather than an injected service on purpose: this file is
// deliberately dependency-free (see above), and importing the config service
// here would reintroduce the circular import that TDZ-crashes boot under swc.
let storedWildcards: string | null = null;
let storedAppDomain: string | null = null;
let cache: { suffix: string; secret: string | null }[] | null = null;

export function setWildcardOverride(domains: string | null, appDomain: string | null): void {
  storedWildcards = domains;
  storedAppDomain = appDomain;
  cache = null;
}

function parseWildcardDomains(): { suffix: string; secret: string | null }[] {
  const explicit = (process.env.PLATFORM_WILDCARD_DOMAINS || storedWildcards || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [suffix, secret] = entry.split('=').map((part) => part.trim());
      if (!suffix) return [];
      const normalized = suffix.startsWith('.') ? suffix : `.${suffix}`;
      return [{ suffix: normalized, secret: secret || null }];
    });

  if (explicit.length) return explicit;

  const appDomain = (process.env.APP_DOMAIN || storedAppDomain || '')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (!appDomain) return [];

  return [{ suffix: `.${appDomain}`, secret: null }];
}

export function platformWildcardDomains(): { suffix: string; secret: string | null }[] {
  if (!cache) cache = parseWildcardDomains();
  return cache;
}

export function isPlatformGeneratedHost(host: string): boolean {
  return platformWildcardDomains().some((w) => host.endsWith(w.suffix));
}

export function formatSlug(value: string): string {
  if (!value) {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .substring(0, 60)
    .replace(/-+$/, '');
}

/**
 * Truncate a generated Kubernetes object name without leaving a trailing
 * dash, which DNS-1123 forbids. Truncation can land mid-separator, so the
 * trim must happen after the cut, never before.
 */
export function truncateK8sName(name: string, max = 63): string {
  return name.substring(0, max).replace(/-+$/, '');
}

export const MASKED_PASSWORD = '****';

export function maskConnectionPassword<T extends string | null | undefined>(url: T): T {
  if (typeof url !== 'string') return url;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/\s]*:)[^@\s]*@/i, `$1${MASKED_PASSWORD}@`) as T;
}

type DatabaseSecrets = {
  dbPassword?: string | null;
  connectionString?: string | null;
  publicConnectionString?: string | null;
  r2ProxyAccessKey?: string | null;
  r2ProxySecret?: string | null;
  r2RestoreAccessKey?: string | null;
  r2RestoreSecret?: string | null;
};

export function redactDatabaseForViewer<
  T extends DatabaseSecrets & { creator?: { email?: string | null } | null }
>(d: T): T & { passwordSet: boolean } {
  return {
    ...stripR2ProxyCreds(d),
    dbPassword: null,
    passwordSet: Boolean(d.dbPassword),
    connectionString: null,
    publicConnectionString: null,
    creator: d.creator ? { ...d.creator, email: null } : d.creator
  } as T & { passwordSet: boolean };
}

export function stripR2ProxyCreds<T extends DatabaseSecrets>(d: T): T {
  return {
    ...d,
    r2ProxyAccessKey: null,
    r2ProxySecret: null,
    r2RestoreAccessKey: null,
    r2RestoreSecret: null
  } as T;
}

export function sealDatabaseCredentials<T extends DatabaseSecrets>(
  d: T
): T & { passwordSet: boolean } {
  const stripped = stripR2ProxyCreds(d);
  return {
    ...stripped,
    dbPassword: null,
    passwordSet: Boolean(d.dbPassword),
    ...('connectionString' in d
      ? { connectionString: maskConnectionPassword(d.connectionString) }
      : {}),
    ...('publicConnectionString' in d
      ? { publicConnectionString: maskConnectionPassword(d.publicConnectionString) }
      : {})
  } as T & { passwordSet: boolean };
}

/**
 * Strip protection secrets from an ingress row. The bypass secret and the
 * password hash must only ever leave the server via the dedicated
 * protection endpoints, which require project edit.
 */
type IngressRouting = {
  host?: string | null;
  path?: string | null;
  tlsSecretName?: string | null;
  entrypoints?: string[] | null;
};

// One rule for the whole API. A certificate means TLS; without one the
// entrypoint the route was created on decides, which is what keeps a tunnel
// install (Cloudflare terminates, nothing in the cluster holds a certificate)
// from advertising http:// URLs.
export function ingressTlsEnabled(ing: IngressRouting): boolean {
  if (ing.tlsSecretName) return true;
  if (Array.isArray(ing.entrypoints) && ing.entrypoints.length > 0) {
    return ing.entrypoints.includes('websecure');
  }
  return true;
}

// The URL a person can paste, which is not derivable from the hostname alone:
// a self-hosted install may serve on ports other than 80 and 443, and only the
// server knows which. Clients that build their own `https://${host}` are wrong
// on those instances, so the API hands them a URL instead.
export function ingressPublicUrl(ing: IngressRouting): string {
  if (!ing.host) return '';
  const [name, ...rest] = ing.host.split('/');
  if (!name) return '';
  const tls = ingressTlsEnabled(ing);
  const configured = (tls ? process.env.PUBLIC_HTTPS_PORT : process.env.PUBLIC_HTTP_PORT) || '';
  const standard = tls ? '443' : '80';
  const port = configured && configured !== standard ? `:${configured}` : '';
  const embedded = rest.length > 0 ? `/${rest.join('/')}` : '';
  return `${tls ? 'https' : 'http'}://${name}${port}${embedded}${ing.path ?? ''}`;
}

export function scrubIngress<
  T extends IngressRouting & {
    protectionPasswordHash?: string | null;
    protectionBypassSecret?: string | null;
  }
>(
  ing: T
): Omit<T, 'protectionPasswordHash' | 'protectionBypassSecret'> & {
  tlsEnabled: boolean;
  url: string;
} {
  const {
    protectionPasswordHash: _protectionPasswordHash,
    protectionBypassSecret: _protectionBypassSecret,
    ...rest
  } = ing;
  return { ...rest, tlsEnabled: ingressTlsEnabled(ing), url: ingressPublicUrl(ing) };
}

export const GIB = 1024 * 1024 * 1024;

export function parseStorageSize(size: string): number | null {
  const m = size.match(/^(\d+)(Mi|Gi|Ti)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'Mi') return n * 1024 * 1024;
  if (m[2] === 'Gi') return n * GIB;
  return n * 1024 * GIB;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 1)}GiB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}MiB`;
}

// Every database with backup storage gets this schedule unless the user picks
// another one. Backups you have to remember to switch on are backups nobody
// has, and an archiving cluster with no base backup grows without bound
// because retention has nothing to expire against.
export const LEGACY_DEFAULT_BACKUP_CRON = '0 3 * * *';

const DEFAULT_BACKUP_WINDOW: [number, number] = [1, 5];

export function parseBackupWindow(raw: string | undefined): [number, number] {
  const m = raw?.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return DEFAULT_BACKUP_WINDOW;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23 || end < start) return DEFAULT_BACKUP_WINDOW;
  return [start, end];
}

export function defaultBackupCronFor(
  namespace: string,
  clusterName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const pinned = env.DEFAULT_DB_BACKUP_CRON?.trim();
  if (pinned) return pinned;
  const [start, end] = parseBackupWindow(env.DEFAULT_DB_BACKUP_WINDOW);
  const slots = (end - start + 1) * 60;
  const slot =
    createHash('sha256').update(`${namespace}/${clusterName}`).digest().readUInt32BE(0) % slots;
  return `${slot % 60} ${start + Math.floor(slot / 60)} * * *`;
}

export function isBackupSchedulePinned(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DEFAULT_DB_BACKUP_CRON?.trim();
}

// CNPG schedules are quartz-style: the leading field is seconds, not minutes.
// A plain 5-field cron pasted from anywhere else has to grow one.
export function toQuartzCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) return `0 ${parts.join(' ')}`;
  return expr.trim();
}

/**
 * Whether an existing ingress should move to a different TLS secret after a
 * wildcard configuration change, and what it should move to.
 *
 * Returns null to leave it alone. Extracted from the reconcile loop so the
 * decision is testable without a cluster: the interesting cases are an ingress
 * holding its own certificate when a wildcard now covers it, and one holding a
 * wildcard secret that no longer exists.
 */
export const OWN_CERT_PREFIX = 'leaf-cert-';

export function desiredWildcardTls(
  host: string,
  currentSecret: string | null,
  newIssuer: string
): { secretName: string | null; clusterIssuer: string | null } | null {
  if (!currentSecret) return null;

  const wildcards = platformWildcardDomains();
  const desired = wildcards.find((w) => host.endsWith(w.suffix))?.secret ?? null;

  if (desired === currentSecret) return null;

  // Once a wildcard is removed from config there is nothing left to compare
  // against, so a stale wildcard secret is told apart from a per-host one by
  // its name. Per-host secrets are always minted as OWN_CERT_PREFIX + uuid.
  const holdsOwnCert = currentSecret.startsWith(OWN_CERT_PREFIX);
  if (!desired && holdsOwnCert) return null;

  return desired
    ? { secretName: desired, clusterIssuer: null }
    : { secretName: null, clusterIssuer: newIssuer };
}

export function assertDeleteConfirmation(expected: string, provided: unknown, noun: string): void {
  if (typeof provided === 'string' && provided.trim() === expected.trim()) return;
  throw new BadRequestException(
    `Type the ${noun} name "${expected}" to confirm. This deletion is permanent and cannot be undone.`
  );
}
