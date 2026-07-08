/**
 * Pure helpers shared between ProjectsService, DatabasesService and friends.
 * Kept dependency-free so any service in the projects module can import them
 * without dragging in DI.
 */

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
  },
>(d: T): T {
  return {
    ...d,
    dbPassword: null,
    connectionString: null,
    publicConnectionString: null,
    r2ProxyAccessKey: null,
    r2ProxySecret: null,
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
  },
>(d: T): T {
  return {
    ...d,
    r2ProxyAccessKey: null,
    r2ProxySecret: null,
  } as T;
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
