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

/**
 * Redact DB credentials from a database payload for viewers.
 * Nulls dbPassword, scrubs password out of connection strings.
 */
export function redactDatabaseForViewer<
  T extends {
    dbPassword?: string | null;
    connectionString?: string | null;
    publicConnectionString?: string | null;
    r2ProxyAccessKey?: string | null;
    r2ProxySecret?: string | null;
  }
>(d: T): T {
  return {
    ...d,
    dbPassword: null,
    connectionString: null,
    publicConnectionString: null,
    r2ProxyAccessKey: null,
    r2ProxySecret: null
  } as T;
}

/**
 * Strip R2 proxy backup credentials from a database payload.
 * These are infrastructure secrets — they should never leave the server
 * via user-facing APIs. The in-cluster CNPG provisioning path reads them
 * directly from prisma, so user-facing callers always go through here.
 */
export function stripR2ProxyCreds<
  T extends {
    r2ProxyAccessKey?: string | null;
    r2ProxySecret?: string | null;
  }
>(d: T): T {
  return {
    ...d,
    r2ProxyAccessKey: null,
    r2ProxySecret: null
  } as T;
}

/**
 * Strip protection secrets from an ingress row. The bypass secret and the
 * password hash must only ever leave the server via the dedicated
 * protection endpoints, which require project edit.
 */
export function scrubIngress<
  T extends {
    protectionPasswordHash?: string | null;
    protectionBypassSecret?: string | null;
  }
>(ing: T): Omit<T, 'protectionPasswordHash' | 'protectionBypassSecret'> {
  const {
    protectionPasswordHash: _protectionPasswordHash,
    protectionBypassSecret: _protectionBypassSecret,
    ...rest
  } = ing;
  return rest;
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
export const DEFAULT_BACKUP_CRON = process.env.DEFAULT_DB_BACKUP_CRON || '0 3 * * *';

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
