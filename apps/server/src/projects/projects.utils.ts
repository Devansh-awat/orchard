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
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
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
