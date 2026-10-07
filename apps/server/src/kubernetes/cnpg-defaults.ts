import { X509Certificate } from 'node:crypto';
import {
  deriveDbTuning,
  MANAGED_DB_MIN_MEMORY_BYTES,
  parsePgMemory,
  walSlotKeepSize
} from './db-tuning';
import { memoryBytesToK8s, parseMemory } from './quantity';
import { completeChain, pemCertificates } from './tls-secret-sync';

export interface ClusterLike {
  spec?: {
    storage?: { size?: string };
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    postgresql?: { parameters?: Record<string, string> };
    certificates?: { serverCASecret?: string | null };
    backup?: {
      barmanObjectStore?: {
        wal?: { maxParallel?: number };
        data?: { compression?: string } | null;
      } | null;
    } | null;
  };
}

export interface TuningOwnership {
  pgParameters?: unknown;
  backupCompression?: string | null;
}

export interface PvcLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { resources?: { requests?: { storage?: string } } };
}

export const WAL_ARCHIVE_MAX_PARALLEL = 4;

export const CNPG_DATA_PVC_ROLE = 'PG_DATA';

export function walCapPatchFor(cluster: ClusterLike): Record<string, string> | null {
  const params = cluster.spec?.postgresql?.parameters ?? {};
  if (params.max_slot_wal_keep_size) return null;
  return { max_slot_wal_keep_size: walSlotKeepSize(cluster.spec?.storage?.size) };
}

export function walArchivePatchFor(cluster: ClusterLike): { maxParallel: number } | null {
  const store = cluster.spec?.backup?.barmanObjectStore;
  if (!store) return null;
  if (store.wal?.maxParallel && store.wal.maxParallel > 1) return null;
  return { maxParallel: WAL_ARCHIVE_MAX_PARALLEL };
}

export function tuningPatchFor(
  cluster: ClusterLike,
  owned: TuningOwnership
): Record<string, unknown> | null {
  const limit = parseMemory(String(cluster.spec?.resources?.limits?.memory ?? ''));
  if (!limit) return null;
  const target = Math.max(limit, MANAGED_DB_MIN_MEMORY_BYTES);
  const tuning = deriveDbTuning({
    memoryLimitBytes: target,
    overrides: {
      sharedBuffers: (owned.pgParameters as Record<string, string> | null)?.shared_buffers,
      backupCompression: owned.backupCompression
    }
  });
  const spec: Record<string, unknown> = {};
  if (limit < target) {
    const memory = memoryBytesToK8s(target);
    spec.resources = { requests: { memory }, limits: { memory } };
  }
  const liveSharedBuffers = parsePgMemory(
    cluster.spec?.postgresql?.parameters?.shared_buffers ?? ''
  );
  if (liveSharedBuffers > parsePgMemory(tuning.sharedBuffers)) {
    spec.postgresql = { parameters: { shared_buffers: tuning.sharedBuffers } };
  }
  const store = cluster.spec?.backup?.barmanObjectStore;
  if (store && store.data?.compression === 'gzip' && tuning.dataCompression === null) {
    spec.backup = { barmanObjectStore: { data: null } };
  }
  return Object.keys(spec).length > 0 ? spec : null;
}

export function laggingDataVolumes(cluster: ClusterLike, pvcs: PvcLike[]): string[] {
  const target = parseMemory(String(cluster.spec?.storage?.size ?? ''));
  if (!target) return [];
  return pvcs
    .filter((pvc) => pvc.metadata?.labels?.['cnpg.io/pvcRole'] === CNPG_DATA_PVC_ROLE)
    .filter((pvc) => parseMemory(String(pvc.spec?.resources?.requests?.storage ?? '')) < target)
    .map((pvc) => pvc.metadata?.name ?? '')
    .filter(Boolean);
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
