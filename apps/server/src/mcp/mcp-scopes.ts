import type { McpScope } from './client';

export const DEFAULT_MCP_SCOPE: McpScope = 'deploy';

export const MCP_SCOPES_SUPPORTED = ['mcp:read', 'mcp:deploy', 'mcp:exec', 'mcp:access'];

const RANK: Record<McpScope, number> = { read: 0, deploy: 1, exec: 2 };

export function mcpScopeClaim(scope?: McpScope): string {
  return `mcp:${scope ?? DEFAULT_MCP_SCOPE}`;
}

function fromToken(token: string): McpScope | null {
  const value = token.trim().toLowerCase();
  if (value === 'mcp:read' || value === 'read') return 'read';
  if (value === 'mcp:deploy' || value === 'deploy' || value === 'mcp:access') return 'deploy';
  if (value === 'mcp:exec' || value === 'exec') return 'exec';
  return null;
}

export function highestScope(scopes: Iterable<McpScope>): McpScope | null {
  let best: McpScope | null = null;
  for (const scope of scopes) {
    if (best === null || RANK[scope] > RANK[best]) best = scope;
  }
  return best;
}

export function parseRequestedScope(raw: string | null | undefined): McpScope {
  const parsed = (raw ?? '')
    .split(/[\s,]+/)
    .map(fromToken)
    .filter((scope): scope is McpScope => scope !== null);
  return highestScope(parsed) ?? DEFAULT_MCP_SCOPE;
}

export function grantedScope(requested: McpScope, granted: unknown): McpScope | null {
  const absent = granted === undefined || granted === null || granted === '';
  const parsed: McpScope | null = absent
    ? 'deploy'
    : typeof granted === 'string'
      ? fromToken(granted)
      : null;
  if (parsed === null) return null;
  return RANK[parsed] <= RANK[requested] ? parsed : requested;
}

export function scopeFromClaim(claim: unknown): McpScope {
  if (typeof claim !== 'string' || !claim) return DEFAULT_MCP_SCOPE;
  return parseRequestedScope(claim);
}

export function scopeFromApiTokenScopes(scopes: unknown): McpScope {
  const list = Array.isArray(scopes)
    ? scopes.filter((s): s is string => typeof s === 'string')
    : [];
  return highestScope(list.map(fromToken).filter((s): s is McpScope => s !== null)) ?? 'read';
}

export function scopeFromHeader(value: unknown): McpScope {
  const raw = Array.isArray(value) ? value[0] : value;
  return fromToken(typeof raw === 'string' ? raw : '') ?? DEFAULT_MCP_SCOPE;
}
