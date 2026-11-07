import * as net from 'net';

export const PRIVATE_EGRESS_EXCEPT = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10'
];

interface Range {
  cidr: string;
  start: number;
  end: number;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function toRange(value: string): Range | null {
  const [address, prefixRaw, extra] = value.trim().split('/');
  if (extra !== undefined || !address || !net.isIPv4(address)) return null;
  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipv4ToInt(address) / size) * size;
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(start / 2 ** shift) % 256);
  return { cidr: `${octets.join('.')}/${prefix}`, start, end: start + size - 1 };
}

export function publicIpv4Excepts(values: Iterable<string | null | undefined>): string[] {
  const covered = PRIVATE_EGRESS_EXCEPT.map(toRange).filter((r): r is Range => r !== null);
  const found = new Map<string, Range>();
  for (const value of values) {
    const range = value ? toRange(value) : null;
    if (!range) continue;
    if (covered.some((c) => c.start <= range.start && range.end <= c.end)) continue;
    found.set(range.cidr, range);
  }
  return [...found.keys()].sort();
}

export function nodeAndApiserverAddresses(
  nodes: { status?: { addresses?: { type: string; address: string }[] }; spec?: any }[],
  apiserver: string[],
  extra: string | undefined
): string[] {
  const out: string[] = [...apiserver];
  for (const node of nodes) {
    for (const entry of node.status?.addresses ?? []) {
      if (entry.type === 'InternalIP' || entry.type === 'ExternalIP') out.push(entry.address);
    }
    out.push(...(node.spec?.podCIDRs ?? []));
  }
  out.push(
    ...(extra || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  return out;
}
