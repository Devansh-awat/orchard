const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MCP_ORG_DEVICE = 'mcp-org';

const devicePrefixes = new Set<string>([MCP_ORG_DEVICE]);

export const ORG_SCOPED_DENY = [
  'auth/',
  'ssh-identities',
  'invitations',
  'users/',
  'setup',
  'admin/',
  'github/link',
  'github/unlink',
  'github/status',
  'github/repositories',
  'github/app/install',
  'git/oauth/',
  'tailscale/link',
  'tailscale/unlink'
];

export function registerOrgScopedDevice(prefix: string): void {
  devicePrefixes.add(prefix);
}

export function denyToOrgScopedSessions(path: string): void {
  const clean = path.replace(/^\/+/, '');
  if (!ORG_SCOPED_DENY.includes(clean)) ORG_SCOPED_DENY.push(clean);
}

export function orgScopedDevice(
  prefix: string,
  organizationId: string | null | undefined,
  subject: string
): string {
  return `${prefix}:${organizationId || 'personal'}:${subject}`;
}

export function plainDeviceName(name: string): string {
  return name.replaceAll(':', ' ');
}

export function deviceLabel(deviceName: string | null): string | null {
  const prefix = `${MCP_ORG_DEVICE}:`;
  if (!deviceName?.startsWith(prefix)) return deviceName;
  return deviceName.slice(prefix.length).split(':').slice(1).join(':');
}

export function isScopedDevice(deviceName: string | null | undefined): boolean {
  if (!deviceName) return false;
  for (const prefix of devicePrefixes) {
    if (deviceName.startsWith(`${prefix}:`)) return true;
  }
  return false;
}

export function deviceOrgScope(deviceName: string | null | undefined): string | undefined {
  if (!deviceName) return undefined;
  for (const prefix of devicePrefixes) {
    if (!deviceName.startsWith(`${prefix}:`)) continue;
    const org = deviceName.slice(prefix.length + 1).split(':')[0];
    return UUID_RE.test(org) ? org.toLowerCase() : undefined;
  }
  return undefined;
}
