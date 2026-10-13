const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const devicePrefixes = new Set<string>();

export const ORG_SCOPED_DENY = [
  'invitations',
  'users/',
  'setup',
  'admin/',
  'github/link',
  'github/unlink',
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

export function orgScopedDevice(prefix: string, organizationId: string | null | undefined, subject: string): string {
  return `${prefix}:${organizationId || 'personal'}:${subject}`;
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
