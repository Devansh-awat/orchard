export type HostnameRole = 'platform' | 'apps' | 'mcp';

export interface ExpectedHostname {
  role: HostnameRole;
  /** What the operator types into their DNS provider. */
  record: string;
  /** A name that can actually be resolved, which for a wildcard is a probe. */
  probe: string;
  label: string;
  detail: string;
}

// A label no generated app URL can produce, so resolving it proves the wildcard
// record exists rather than proving one app happens to be deployed. Generated
// hosts are always `<name>-<project>-<6 hex>`, three hyphenated parts.
export const WILDCARD_PROBE_LABEL = 'orchard-dns-probe';

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || null;
  }
}

/**
 * Every name that has to resolve for this instance to work, derived from what
 * it is already configured with rather than from anything typed in twice.
 *
 * The app domain is a wildcard, so it gets a probe label: `*.apps.example.com`
 * is not a resolvable name, and checking one deployed app's hostname would pass
 * on an instance whose wildcard is missing but which happens to have a single
 * record for that app.
 */
export function expectedHostnames(input: {
  frontendUrl?: string | null;
  appDomain?: string | null;
  mcpUrl?: string | null;
}): ExpectedHostname[] {
  const out: ExpectedHostname[] = [];

  const platform = hostOf(input.frontendUrl);
  if (platform) {
    out.push({
      role: 'platform',
      record: platform,
      probe: platform,
      label: 'Dashboard',
      detail: 'Where people sign in. Everything else is checked against this one.'
    });
  }

  const apps = (input.appDomain || '').trim().replace(/^\*?\./, '');
  if (apps) {
    out.push({
      role: 'apps',
      record: `*.${apps}`,
      probe: `${WILDCARD_PROBE_LABEL}.${apps}`,
      label: 'Deployed apps',
      detail: 'A wildcard, so every generated app URL resolves without its own record.'
    });
  }

  const mcp = hostOf(input.mcpUrl);
  if (mcp) {
    out.push({
      role: 'mcp',
      record: mcp,
      probe: mcp,
      label: 'MCP endpoint',
      detail: 'Where AI agents connect. Its certificate cannot issue until this resolves.'
    });
  }

  return out;
}
