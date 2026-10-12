import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { publisherKeysFromEnv, trustPolicyFromEnv, verifyGraftDir } from './integrity';
import { parseManifest } from './manifest';
import { extractTarGz } from './untar';

export const DEFAULT_MARKETPLACE_URL = 'https://assets.orchard.my/registry';

const specSchema = z.array(
  z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
      version: z.string(),
      source: z.string().optional(),
      digest: z.string().optional()
    })
    .strict()
);

export type GraftSpec = z.infer<typeof specSchema>[number];

export type SyncFailure = { id: string; reason: string };

export type SyncResult = { synced: string[]; failed: SyncFailure[] };

export const SYNC_STATUS_FILE = 'sync-status.json';

export function parseGraftSpecs(raw: string | undefined): GraftSpec[] {
  if (!raw || !raw.trim()) return [];
  const parsed = specSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `ORCHARD_GRAFTS is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }
  const ids = new Set<string>();
  for (const spec of parsed.data) {
    if (ids.has(spec.id)) throw new Error(`ORCHARD_GRAFTS lists ${spec.id} twice`);
    ids.add(spec.id);
  }
  return parsed.data;
}

export function artifactUrl(spec: GraftSpec, marketplace: string): string {
  if (spec.source) return spec.source;
  return `${marketplace.replace(/\/+$/, '')}/grafts/${spec.id}/${spec.version}/${spec.id}-${spec.version}.graft`;
}

function normaliseDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').toLowerCase();
}

async function fetchArtifact(url: string, allowHttp: boolean): Promise<Buffer> {
  if (url.startsWith('file://')) return readFileSync(new URL(url));
  if (url.startsWith('/')) return readFileSync(url);
  if (url.startsWith('oci://'))
    throw new Error('oci:// sources are not supported by this Orchard yet');
  if (url.startsWith('http://') && !allowHttp)
    throw new Error('plain http sources need ORCHARD_GRAFTS_ALLOW_HTTP=1');
  if (!url.startsWith('https://') && !url.startsWith('http://'))
    throw new Error(`unsupported graft source ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function syncGrafts(env: NodeJS.ProcessEnv = process.env): Promise<SyncResult> {
  const specs = parseGraftSpecs(env.ORCHARD_GRAFTS);
  const dest = resolve(env.ORCHARD_GRAFTS_DIR ?? '/app/grafts');
  const marketplace = env.ORCHARD_GRAFT_MARKETPLACE_URL || DEFAULT_MARKETPLACE_URL;
  const dev = env.ORCHARD_GRAFTS_DEV === '1' || env.ORCHARD_GRAFTS_DEV === 'true';
  const allowHttp =
    dev || env.ORCHARD_GRAFTS_ALLOW_HTTP === '1' || env.ORCHARD_GRAFTS_ALLOW_HTTP === 'true';
  const policy = trustPolicyFromEnv(env);
  const keys = publisherKeysFromEnv(env);
  mkdirSync(dest, { recursive: true });

  const result: SyncResult = { synced: [], failed: [] };
  for (const spec of specs) {
    const staging = join(dest, `.staging-${spec.id}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      if (!spec.digest && !dev) throw new Error('digest is required (sha256 of the .graft file)');
      const url = artifactUrl(spec, marketplace);
      const archive = await fetchArtifact(url, allowHttp);
      const actual = createHash('sha256').update(archive).digest('hex');
      if (spec.digest && normaliseDigest(spec.digest) !== actual) {
        throw new Error(
          `digest mismatch: expected ${normaliseDigest(spec.digest)}, downloaded ${actual}`
        );
      }
      extractTarGz(archive, staging);
      const manifest = parseManifest(JSON.parse(readFileSync(join(staging, 'graft.json'), 'utf8')));
      if (manifest.id !== spec.id)
        throw new Error(`artifact is graft ${manifest.id}, not ${spec.id}`);
      if (manifest.version !== spec.version)
        throw new Error(`artifact is version ${manifest.version}, not ${spec.version}`);
      verifyGraftDir(staging, policy, keys);
      const target = join(dest, spec.id);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      result.synced.push(spec.id);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      result.failed.push({ id: spec.id, reason: (err as Error).message });
    }
  }
  writeFileSync(
    join(dest, 'index.json'),
    JSON.stringify({ order: specs.map((s) => s.id) }, null, 2)
  );
  writeFileSync(join(dest, SYNC_STATUS_FILE), JSON.stringify({ failed: result.failed }, null, 2));
  return result;
}

export function readSyncFailures(dir: string): SyncFailure[] {
  const path = join(dir, SYNC_STATUS_FILE);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { failed?: SyncFailure[] }).failed ?? [];
}
