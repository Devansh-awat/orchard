import { load } from 'js-yaml';
import { majorFromImage } from './cnpg-spec-sync';

export const POSTGRES_IMAGE_REPOSITORY = 'ghcr.io/cloudnative-pg/postgresql';

export const DEFAULT_POSTGRES_IMAGE_CATALOG_URL =
  'https://raw.githubusercontent.com/cloudnative-pg/artifacts/main/image-catalogs/catalog-system-trixie.yaml';

export const FALLBACK_POSTGRES_IMAGES: Readonly<Record<number, string>> = {
  13: 'ghcr.io/cloudnative-pg/postgresql:13.22-202511100817-system-trixie@sha256:c3cb9c42e2940c5205218f1d527cbbdb894611eed028b1c8ee61123b820bff73',
  14: 'ghcr.io/cloudnative-pg/postgresql:14.24-202610190957-system-trixie@sha256:de03f7e2122212118f056bffee7d64064f5a4bd07d0e2810fba6fce9f565a126',
  15: 'ghcr.io/cloudnative-pg/postgresql:15.19-202610190958-system-trixie@sha256:07d64904f21cf8b6c5b02c8372530d48b383ebbdb0450c24d516138b7527c8ab',
  16: 'ghcr.io/cloudnative-pg/postgresql:16.15-202610190958-system-trixie@sha256:8ca5699981c25db72e549e9fa69561bac233df15b9b1e3a6282847b0629bb5ea',
  17: 'ghcr.io/cloudnative-pg/postgresql:17.11-202610190957-system-trixie@sha256:ae22bdd6008e02c18180c84192b3afbc95a758a184899f1cb7e85ed9c3ef8128',
  18: 'ghcr.io/cloudnative-pg/postgresql:18.6-202610190957-system-trixie@sha256:f7e00138159bb45d70b624ba25e446924cb3ed1bf366d13e936c3f81b914064e'
};

export interface PostgresImageChannel {
  images: Record<number, string>;
  source: string;
  catalogDate: string | null;
  fetchedAt: string;
}

export function imageRepository(image: string): string {
  const withoutDigest = image.split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export function parsePostgresImageCatalog(text: string): {
  images: Record<number, string>;
  catalogDate: string | null;
} {
  const doc = load(text) as any;
  if (!doc || (doc.kind !== 'ClusterImageCatalog' && doc.kind !== 'ImageCatalog')) {
    throw new Error('not a CNPG image catalog');
  }
  const images: Record<number, string> = {};
  for (const entry of Array.isArray(doc.spec?.images) ? doc.spec.images : []) {
    const major = Number(entry?.major);
    if (Number.isInteger(major) && typeof entry?.image === 'string') images[major] = entry.image;
  }
  const date = doc.metadata?.labels?.['images.cnpg.io/date'];
  return { images, catalogDate: typeof date === 'string' ? date : null };
}

export function validPostgresImages(
  images: Record<number, string>,
  opts: { repository?: string } = {}
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, image] of Object.entries(images)) {
    const major = Number(key);
    if (!Number.isInteger(major) || major < 13) continue;
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) continue;
    if (majorFromImage(image) !== major) continue;
    if (opts.repository && imageRepository(image) !== opts.repository) continue;
    out[major] = image;
  }
  return out;
}

export function resolvePostgresImage(
  major: number,
  channel: PostgresImageChannel | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  const pinned = env[`POSTGRES_IMAGE_${major}`]?.trim();
  if (pinned) return pinned;
  return (
    channel?.images[major] ??
    FALLBACK_POSTGRES_IMAGES[major] ??
    `${POSTGRES_IMAGE_REPOSITORY}:${major}`
  );
}

export function parseHourWindow(
  raw: string | undefined,
  fallback: [number, number]
): [number, number] {
  const m = raw?.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return fallback;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) return fallback;
  return [start, end];
}

export function hourInWindow(hour: number, [start, end]: [number, number]): boolean {
  return start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
}

export interface ImageRolloutCandidate {
  namespace: string;
  clusterName: string;
  current: string | null;
  target: string;
  healthy: boolean;
  hibernated: boolean;
  backupRunning: boolean;
  collation: 'c' | 'other' | null;
}

export function isOutdated(c: Pick<ImageRolloutCandidate, 'current' | 'target'>): boolean {
  if (!c.current || c.current === c.target) return false;
  if (majorFromImage(c.current) !== majorFromImage(c.target)) return false;
  const repo = imageRepository(c.current);
  return repo === imageRepository(c.target) || repo === POSTGRES_IMAGE_REPOSITORY;
}

export function imageOsBase(image: string | null | undefined): string | null {
  if (!image) return null;
  const ref = image.split('@')[0];
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon <= slash) return null;
  const last =
    ref
      .slice(colon + 1)
      .split('-')
      .at(-1) ?? '';
  return /^[a-z]{3,}$/.test(last) ? last : null;
}

export function osBaseChanges(current: string | null, target: string): boolean {
  const from = imageOsBase(current);
  return !from || from !== imageOsBase(target);
}

export function pickImageRolloutBatch(
  candidates: ImageRolloutCandidate[],
  limit: number
): ImageRolloutCandidate[] {
  return candidates
    .filter((c) => isOutdated(c) && c.healthy && !c.hibernated && !c.backupRunning)
    .filter((c) => c.collation !== 'other' || !osBaseChanges(c.current, c.target))
    .sort((a, b) =>
      `${a.namespace}/${a.clusterName}`.localeCompare(`${b.namespace}/${b.clusterName}`)
    )
    .slice(0, Math.max(0, limit));
}

export function clusterSettled(cluster: any, target: string): boolean {
  const status = cluster?.status ?? {};
  const wanted = Number(cluster?.spec?.instances ?? 1);
  const imageApplied = !status.image || status.image === target;
  return (
    status.phase === 'Cluster in healthy state' &&
    Number(status.readyInstances ?? 0) >= wanted &&
    imageApplied
  );
}
