import * as net from 'net';
import { promises as dns } from 'dns';
import * as k8s from '@kubernetes/client-node';
import { TENANT_PRIVATE_EGRESS_EXCEPT } from './security-policies';

const MIN_EXCEPT_PREFIX = 8;

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

interface Range {
  cidr: string;
  start: number;
  end: number;
}

function ipv4Range(value: string): Range | null {
  const [address, prefixRaw, extra] = value.trim().split('/');
  if (extra !== undefined || !address || !net.isIPv4(address)) return null;
  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < MIN_EXCEPT_PREFIX || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipv4ToInt(address) / size) * size;
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(start / 2 ** shift) % 256);
  return { cidr: `${octets.join('.')}/${prefix}`, start, end: start + size - 1 };
}

export function ipv4Excepts(
  values: Iterable<string | null | undefined>,
  covered: string[] = TENANT_PRIVATE_EGRESS_EXCEPT
): string[] {
  const cover = covered.map(ipv4Range).filter((r): r is Range => r !== null);
  const ranges = new Map<string, Range>();
  for (const value of values) {
    const range = value ? ipv4Range(value) : null;
    if (!range) continue;
    if (cover.some((c) => c.start <= range.start && range.end <= c.end)) continue;
    ranges.set(range.cidr, range);
  }
  const all = [...ranges.values()];
  return all
    .filter(
      (r) => !all.some((o) => o !== r && o.start <= r.start && r.end <= o.end && o.cidr !== r.cidr)
    )
    .map((r) => r.cidr)
    .sort((a, b) => ipv4ToInt(a.split('/')[0]) - ipv4ToInt(b.split('/')[0]) || a.localeCompare(b));
}

export function nodeAddresses(nodes: k8s.V1Node[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    for (const entry of node.status?.addresses ?? []) {
      if (entry.type === 'InternalIP' || entry.type === 'ExternalIP') out.push(entry.address);
    }
    out.push(...(node.spec?.podCIDRs ?? []), ...(node.spec?.podCIDR ? [node.spec.podCIDR] : []));
  }
  return out;
}

export function extraDenyCidrs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PLATFORM_EXTRA_DENY_CIDRS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function serverHostAddresses(server: string | undefined): Promise<string[]> {
  if (!server) return [];
  let host: string;
  try {
    host = new URL(server).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return [];
  }
  if (net.isIP(host)) return [host];
  try {
    const found = await dns.lookup(host, { all: true, family: 4 });
    return found.map((entry) => entry.address);
  } catch {
    return [];
  }
}
