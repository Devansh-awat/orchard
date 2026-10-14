import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { digestOf, readArtifactManifest } from '../grafts/artifact';
import { resolveClaims } from '../grafts/claims';
import { DOOR_CLASSES } from '../grafts/doors';
import {
  GRAFT_DOORS,
  GRAFT_SDK_VERSION,
  missingDoors,
  platformVersion,
  registerDoors
} from '../grafts/host-api';
import {
  decideSignature,
  enforceTrust,
  graftTrustFromEnv,
  verifyFileManifest,
  type GraftSignature
} from '../grafts/integrity';
import { graftsDir } from '../grafts/loader';
import { parseManifest, type GraftManifest } from '../grafts/manifest';
import { applyMigrations, graftRole, graftSchema, readMigrations } from '../grafts/migrations';
import { satisfies } from '../grafts/semver';
import {
  artifactUrl,
  DEFAULT_MARKETPLACE_URL,
  fetchArtifact,
  fetchRevoked,
  parseGraftSpecs,
  recordOrigin,
  revocationProblem
} from '../grafts/sync';
import { extractTarGz } from '../grafts/untar';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function installedManifests(): GraftManifest[] {
  const root = graftsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'graft.json')))
    .map((e) => {
      try {
        return parseManifest(JSON.parse(readFileSync(join(root, e.name, 'graft.json'), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter((m): m is GraftManifest => m !== null);
}

async function store() {
  const archive = await readStdin();
  if (archive.length === 0) throw new Error('nothing on stdin');
  const manifest = readArtifactManifest(archive);
  const digest = digestOf(archive);
  await withDb((db) =>
    db.query(
      `INSERT INTO graft_artifacts (digest, graft_id, version, size, content)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (digest) DO NOTHING`,
      [digest, manifest.id, manifest.version, archive.length, archive]
    )
  );
  print({ id: manifest.id, version: manifest.version, digest, source: `orchard://${digest}` });
}

async function info() {
  const ledger = await withDb(async (db) => {
    const { rows } = await db.query<{ graft_id: string; name: string }>(
      'SELECT graft_id, name FROM graft_migrations ORDER BY graft_id, name'
    );
    return rows;
  }).catch(() => []);
  print({
    platform: platformVersion(),
    sdk: GRAFT_SDK_VERSION,
    doors: GRAFT_DOORS,
    installed: installedManifests().map((m) => ({
      id: m.id,
      version: m.version,
      requires: m.requires.grafts,
      migrations: ledger.filter((r) => r.graft_id === m.id).map((r) => r.name)
    }))
  });
}

async function check(rawSpec: string, dryRun: boolean) {
  const [spec] = parseGraftSpecs(`[${rawSpec}]`);
  const problems: string[] = [];
  const marketplace = process.env.ORCHARD_GRAFT_MARKETPLACE_URL || DEFAULT_MARKETPLACE_URL;
  const trust = graftTrustFromEnv();
  const archive = await fetchArtifact(
    artifactUrl(spec, marketplace, trust.taps),
    true,
    process.env.DATABASE_URL
  );
  const digest = digestOf(archive);
  if (spec.digest && spec.digest.replace(/^sha256:/, '') !== digest.replace(/^sha256:/, '')) {
    throw new Error(`digest mismatch: expected ${spec.digest}, got ${digest}`);
  }
  const { revoked, warning } = await fetchRevoked(marketplace, true);
  const revokedProblem = revocationProblem(revoked, spec, digest);
  if (revokedProblem) problems.push(revokedProblem);
  const dir = mkdtempSync(join(tmpdir(), 'graft-check-'));
  try {
    extractTarGz(archive, dir);
    const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'graft.json'), 'utf8')));
    const listingProblem = await recordOrigin(spec, dir, marketplace, true);
    let signature: GraftSignature | null = null;
    try {
      verifyFileManifest(dir);
      signature = decideSignature(dir, trust);
      enforceTrust(signature, trust.policy);
    } catch (err) {
      problems.push(
        listingProblem ? `${(err as Error).message} (${listingProblem})` : (err as Error).message
      );
    }
    const platform = platformVersion();
    if (!satisfies(platform, manifest.engines.platform)) {
      problems.push(`needs Orchard ${manifest.engines.platform}, this is ${platform}`);
    }
    if (!satisfies(GRAFT_SDK_VERSION, manifest.engines.sdk)) {
      problems.push(
        `needs graft SDK ${manifest.engines.sdk}, this Orchard provides ${GRAFT_SDK_VERSION}`
      );
    }
    const missing = missingDoors(manifest.uses);
    if (missing.length)
      problems.push(`uses doors this Orchard does not provide: ${missing.join(', ')}`);
    const others = installedManifests().filter((m) => m.id !== manifest.id);
    for (const [dep, range] of Object.entries(manifest.requires.grafts)) {
      const found = others.find((m) => m.id === dep);
      if (!found) problems.push(`requires graft ${dep} ${range}, which is not installed`);
      else if (!satisfies(found.version, range))
        problems.push(`requires graft ${dep} ${range}, found ${found.version}`);
    }
    const claims = resolveClaims([...others, manifest]).get(manifest.id) ?? [];
    const shadowed = claims.filter((c) => c.state === 'shadowed');
    let migration: { pending: string[]; dryRun: 'ok' | 'skipped' | string } = {
      pending: [],
      dryRun: 'skipped'
    };
    const migrations = readMigrations(dir);
    if (migrations.length) {
      await withDb(async (db) => {
        try {
          const result = await applyMigrations(db, manifest.id, migrations, { dryRun: true });
          migration = { pending: result.applied, dryRun: dryRun ? 'ok' : 'skipped' };
        } catch (err) {
          migration = { pending: [], dryRun: (err as Error).message };
          problems.push(`migrations would fail: ${(err as Error).message}`);
        }
      });
    }
    print({
      manifest,
      digest,
      signature,
      trust: trust.policy,
      warnings: warning ? [warning] : [],
      problems,
      shadowedClaims: shadowed,
      publicRoutes: manifest.public.routes,
      migrations: migration
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ledger(id: string) {
  const rows = await withDb(async (db) => {
    const result = await db.query(
      'SELECT graft_id, name, checksum, applied_at FROM graft_migrations WHERE graft_id = $1 ORDER BY name',
      [id]
    );
    return result.rows;
  });
  print(rows);
}

async function ledgerRestore(id: string) {
  const rows = JSON.parse((await readStdin()).toString('utf8')) as {
    name: string;
    checksum: string;
    applied_at: string;
  }[];
  await withDb(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM graft_migrations WHERE graft_id = $1', [id]);
      for (const row of rows) {
        await db.query(
          'INSERT INTO graft_migrations (graft_id, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
          [id, row.name, row.checksum, row.applied_at]
        );
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  });
  print({ id, restored: rows.length });
}

async function purge(id: string) {
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error('invalid graft id');
  if (installedManifests().some((m) => m.id === id)) {
    throw new Error(`${id} is still installed on this pod; remove it and roll out before purging`);
  }
  const schema = graftSchema(id);
  const role = graftRole(id);
  await withDb(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.query('DELETE FROM graft_migrations WHERE graft_id = $1', [id]);
      await db.query('DELETE FROM graft_artifacts WHERE graft_id = $1', [id]);
      await db.query('DELETE FROM instance_settings WHERE key LIKE $1', [`graft:${id}:%`]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount) {
      await db.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await db.query(`DROP ROLE "${role}"`).catch(() => undefined);
    }
  });
  print({ id, purged: true, schema });
}

async function main() {
  registerDoors(DOOR_CLASSES.map((cls) => cls.meta));
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'store':
      return store();
    case 'info':
      return info();
    case 'check':
      return check(args[0], args.includes('--dry-run'));
    case 'ledger':
      return ledger(args[0]);
    case 'ledger-restore':
      return ledgerRestore(args[0]);
    case 'purge':
      return purge(args[0]);
    default:
      throw new Error(
        'usage: graft-admin store|info|check <spec> [--dry-run]|ledger <id>|ledger-restore <id>|purge <id>'
      );
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
