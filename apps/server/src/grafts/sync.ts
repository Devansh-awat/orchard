import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { z } from 'zod';
import {
  graftTrustFromEnv,
  LISTING_FILE,
  LISTING_SIG_FILE,
  ORIGIN_FILE,
  signedByOrchard,
  TAP_NAME,
  verifyGraftDir,
  type GraftOrigin,
  type GraftTap
} from './integrity';
import {
  loadVerifiedRegistryIndex,
  MissingRegistryObject,
  parseRegistryState,
  registrySignaturePolicyFromEnv,
  registryStateKey,
  type RegistryIndexState,
  type RegistryIndexStateStore
} from '../registry-index/signed-index';
import { parseManifest } from './manifest';
import { extractTarGz } from './untar';

export const DEFAULT_MARKETPLACE_URL = 'https://assets.orchard.my/registry';

const specSchema = z.array(
  z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
      version: z.string(),
      source: z.string().optional(),
      digest: z.string().optional(),
      tap: z.string().regex(TAP_NAME).optional()
    })
    .strict()
);

export type GraftSpec = z.infer<typeof specSchema>[number];

export type SyncFailure = { id: string; reason: string };

export type SyncResult = { synced: string[]; failed: SyncFailure[]; warnings: string[] };

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

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export function graftOrigin(spec: GraftSpec): GraftOrigin {
  if (spec.tap) return { source: 'tap', tap: spec.tap };
  if (spec.source?.startsWith('orchard://')) return { source: 'stored' };
  if (spec.source) return { source: 'url' };
  return { source: 'marketplace' };
}

export function artifactUrl(spec: GraftSpec, marketplace: string, taps: GraftTap[] = []): string {
  const file = `grafts/${spec.id}/${spec.version}/${spec.id}-${spec.version}.graft`;
  if (spec.tap) {
    if (spec.source) throw new Error('set either tap or source, not both');
    const tap = taps.find((t) => t.name === spec.tap);
    if (!tap) {
      throw new Error(
        `tap ${spec.tap} is not configured; add it with orchardctl graft tap add or graftSettings.taps`
      );
    }
    return `${trimBase(tap.url)}/${file}`;
  }
  if (spec.source) return spec.source;
  return `${trimBase(marketplace)}/${file}`;
}

function normaliseDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').toLowerCase();
}

async function fetchStored(digest: string, databaseUrl: string | undefined): Promise<Buffer> {
  if (!databaseUrl)
    throw new Error('orchard:// sources need DATABASE_URL in the graft-sync environment');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ content: Buffer }>(
      'SELECT content FROM graft_artifacts WHERE digest = $1',
      [digest]
    );
    if (!rows[0])
      throw new Error(`no stored artifact ${digest}; upload it again with orchardctl graft add`);
    return rows[0].content;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function fetchArtifact(
  url: string,
  allowHttp: boolean,
  databaseUrl?: string,
  timeoutMs?: number
): Promise<Buffer> {
  if (url.startsWith('orchard://')) return fetchStored(url.slice('orchard://'.length), databaseUrl);
  if (url.startsWith('file://')) return readFileSync(new URL(url));
  if (url.startsWith('/')) return readFileSync(url);
  if (url.startsWith('oci://'))
    throw new Error('oci:// sources are not supported by this Orchard yet');
  if (url.startsWith('http://') && !allowHttp)
    throw new Error('plain http sources need ORCHARD_GRAFTS_ALLOW_HTTP=1');
  if (!url.startsWith('https://') && !url.startsWith('http://'))
    throw new Error(`unsupported graft source ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
  });
  if (res.status === 404)
    throw new MissingRegistryObject(`download failed: ${res.status} ${res.statusText} for ${url}`);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const MARKETPLACE_TIMEOUT_MS = 15_000;

const REGISTRY_STATE_FILE = '.registry-state.json';

function fileStateStore(env: NodeJS.ProcessEnv): RegistryIndexStateStore {
  const path = join(resolve(env.ORCHARD_GRAFTS_DIR ?? '/app/grafts'), REGISTRY_STATE_FILE);
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    load: async (name) => parseRegistryState(read()[name]),
    save: async (name, state) => {
      try {
        mkdirSync(resolve(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({ ...read(), [name]: JSON.stringify(state) }));
      } catch (err) {
        console.warn(
          `[graft-sync] warning: could not record the accepted registry state, rollback protection is off: ${(err as Error).message}`
        );
      }
    }
  };
}

export function registryStateStoreFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryIndexStateStore {
  const file = fileStateStore(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return file;
  const withClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  };
  return {
    load: async (name) => {
      try {
        const { rows } = await withClient((c) =>
          c.query<{ value: string }>('SELECT value FROM instance_settings WHERE key = $1', [
            registryStateKey(name)
          ])
        );
        return parseRegistryState(rows[0]?.value);
      } catch {
        return file.load(name);
      }
    },
    save: async (name, state) => {
      try {
        await withClient((c) =>
          c.query(
            'INSERT INTO instance_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
            [registryStateKey(name), JSON.stringify(state)]
          )
        );
      } catch {
        await file.save(name, state);
      }
    }
  };
}

export async function fetchRevoked(
  marketplace: string,
  allowHttp: boolean,
  options: { env?: NodeJS.ProcessEnv; store?: RegistryIndexStateStore; now?: Date } = {}
): Promise<{ revoked: Set<string> | null; warning?: string }> {
  const env = options.env ?? process.env;
  const store = options.store ?? registryStateStoreFromEnv(env);
  const name = 'grafts/index.json';
  const toSet = (list: unknown) =>
    new Set(
      (Array.isArray(list) ? list : [])
        .filter((d): d is string => typeof d === 'string')
        .map((d) => `sha256:${normaliseDigest(d)}`)
    );
  try {
    const verified = await loadVerifiedRegistryIndex({
      name,
      read: async (suffix) => {
        try {
          return await fetchArtifact(
            `${trimBase(marketplace)}/${name}${suffix}`,
            allowHttp,
            undefined,
            MARKETPLACE_TIMEOUT_MS
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT')
            throw new MissingRegistryObject(String(err));
          throw err;
        }
      },
      store,
      policy: registrySignaturePolicyFromEnv(env),
      now: options.now,
      remember: (v) => ({ revoked: [...toSet((v.body as { revoked?: unknown }).revoked)] })
    });
    for (const warning of verified.warnings) console.warn(`[graft-sync] warning: ${warning}`);
    return { revoked: toSet((verified.body as { revoked?: unknown }).revoked) };
  } catch (err) {
    let last: RegistryIndexState | null = null;
    try {
      last = await store.load(name);
    } catch {
      last = null;
    }
    if (last?.revoked) {
      return {
        revoked: new Set(last.revoked),
        warning: `could not accept the Extension Marketplace catalog, so the last accepted revocation list was used: ${(err as Error).message}`
      };
    }
    return {
      revoked: null,
      warning: `could not read the Extension Marketplace catalog, so revoked versions were not checked: ${(err as Error).message}`
    };
  }
}

export function revocationProblem(
  revoked: Set<string> | null,
  spec: Pick<GraftSpec, 'id' | 'version'>,
  digest: string
): string | null {
  if (!revoked?.has(`sha256:${normaliseDigest(digest)}`)) return null;
  return `${spec.id} ${spec.version} (sha256:${normaliseDigest(digest)}) was revoked by the Extension Marketplace; install another version`;
}

export async function recordOrigin(
  spec: GraftSpec,
  dir: string,
  marketplace: string,
  allowHttp: boolean
): Promise<string | null> {
  const origin = graftOrigin(spec);
  writeFileSync(join(dir, ORIGIN_FILE), JSON.stringify(origin));
  if (origin.source !== 'marketplace' || !existsSync(join(dir, 'MANIFEST.sig'))) return null;
  if (signedByOrchard(dir)) return null;
  const base = `${trimBase(marketplace)}/grafts/${spec.id}/listing.json`;
  try {
    const [listing, signature] = await Promise.all([
      fetchArtifact(base, allowHttp, undefined, MARKETPLACE_TIMEOUT_MS),
      fetchArtifact(`${base}.sig`, allowHttp, undefined, MARKETPLACE_TIMEOUT_MS)
    ]);
    writeFileSync(join(dir, LISTING_FILE), listing);
    writeFileSync(join(dir, LISTING_SIG_FILE), signature);
    return null;
  } catch (err) {
    return `could not fetch its marketplace listing: ${(err as Error).message}`;
  }
}

export async function syncGrafts(env: NodeJS.ProcessEnv = process.env): Promise<SyncResult> {
  const specs = parseGraftSpecs(env.ORCHARD_GRAFTS);
  const dest = resolve(env.ORCHARD_GRAFTS_DIR ?? '/app/grafts');
  const marketplace = env.ORCHARD_GRAFT_MARKETPLACE_URL || DEFAULT_MARKETPLACE_URL;
  const dev = env.ORCHARD_GRAFTS_DEV === '1' || env.ORCHARD_GRAFTS_DEV === 'true';
  const allowHttp =
    dev || env.ORCHARD_GRAFTS_ALLOW_HTTP === '1' || env.ORCHARD_GRAFTS_ALLOW_HTTP === 'true';
  const trust = graftTrustFromEnv(env);
  mkdirSync(dest, { recursive: true });

  const result: SyncResult = { synced: [], failed: [], warnings: [] };
  const { revoked, warning } = specs.length
    ? await fetchRevoked(marketplace, allowHttp, { env })
    : { revoked: null };
  if (warning) result.warnings.push(warning);
  for (const spec of specs) {
    const staging = join(dest, `.staging-${spec.id}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      if (!spec.digest && !dev) throw new Error('digest is required (sha256 of the .graft file)');
      const url = artifactUrl(spec, marketplace, trust.taps);
      const archive = await fetchArtifact(url, allowHttp, env.DATABASE_URL);
      const actual = createHash('sha256').update(archive).digest('hex');
      if (spec.digest && normaliseDigest(spec.digest) !== actual) {
        throw new Error(
          `digest mismatch: expected ${normaliseDigest(spec.digest)}, downloaded ${actual}`
        );
      }
      const revokedProblem = revocationProblem(revoked, spec, actual);
      if (revokedProblem) throw new Error(revokedProblem);
      extractTarGz(archive, staging);
      const manifest = parseManifest(JSON.parse(readFileSync(join(staging, 'graft.json'), 'utf8')));
      if (manifest.id !== spec.id)
        throw new Error(`artifact is graft ${manifest.id}, not ${spec.id}`);
      if (manifest.version !== spec.version)
        throw new Error(`artifact is version ${manifest.version}, not ${spec.version}`);
      const listingProblem = await recordOrigin(spec, staging, marketplace, allowHttp);
      try {
        verifyGraftDir(staging, trust);
      } catch (err) {
        throw new Error(
          listingProblem ? `${(err as Error).message} (${listingProblem})` : (err as Error).message
        );
      }
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
