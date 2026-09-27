import { X509Certificate } from 'node:crypto';
import { walSlotKeepSize } from './db-tuning';
import { completeChain, pemCertificates } from './tls-secret-sync';

export interface ClusterLike {
  spec?: {
    storage?: { size?: string };
    postgresql?: { parameters?: Record<string, string> };
    certificates?: { serverCASecret?: string | null };
  };
}

export function walCapPatchFor(cluster: ClusterLike): Record<string, string> | null {
  const params = cluster.spec?.postgresql?.parameters ?? {};
  if (params.max_slot_wal_keep_size) return null;
  return { max_slot_wal_keep_size: walSlotKeepSize(cluster.spec?.storage?.size) };
}

function endsAtRoot(certs: string[]): boolean {
  const last = certs[certs.length - 1];
  if (!last) return false;
  try {
    const cert = new X509Certificate(last);
    return cert.issuer === cert.subject;
  } catch {
    return false;
  }
}

export function repairedCaBundle(
  data: { 'ca.crt'?: string; 'tls.crt'?: string },
  roots?: readonly string[]
): string | null {
  const tlsPem = data['tls.crt'] ? Buffer.from(data['tls.crt'], 'base64').toString('utf8') : '';
  const caPem = data['ca.crt'] ? Buffer.from(data['ca.crt'], 'base64').toString('utf8') : '';
  const current = pemCertificates(caPem);
  const base = current.length > 0 ? current : pemCertificates(tlsPem).slice(1);
  if (base.length === 0 || endsAtRoot(base)) return null;
  const bundle = roots ? completeChain(base, roots) : completeChain(base);
  if (bundle.length === base.length) return null;
  return Buffer.from(`${bundle.join('\n')}\n`, 'utf8').toString('base64');
}
