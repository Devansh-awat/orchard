export const SANDBOX_MCP_DEVICE = 'sandbox-mcp';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sandboxMcpDevice(
  organizationId: string | null | undefined,
  sandboxId: string
): string {
  return `${SANDBOX_MCP_DEVICE}:${organizationId || 'personal'}:${sandboxId}`;
}

export function sandboxMcpOrgScope(deviceName: string | null | undefined): string | undefined {
  if (!deviceName || !deviceName.startsWith(`${SANDBOX_MCP_DEVICE}:`)) return undefined;
  const org = deviceName.slice(SANDBOX_MCP_DEVICE.length + 1).split(':')[0];
  return UUID_RE.test(org) ? org.toLowerCase() : undefined;
}
