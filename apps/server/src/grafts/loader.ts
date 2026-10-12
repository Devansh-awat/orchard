import { Logger, type DynamicModule, type Type } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import Module from 'node:module';
import { join, resolve, sep } from 'node:path';
import { Client } from 'pg';
import { classifyController, isController, type ClassifiedRoute } from '../auth/route-classifier';
import { resolveClaims } from './claims';
import { failGraft, setGraftRecords, type GraftRecord } from './graft-registry';
import { GRAFT_SDK_VERSION, deprecatedDoors, missingDoors, platformVersion } from './host-api';
import {
  listFiles,
  publisherKeysFromEnv,
  sha256File,
  trustPolicyFromEnv,
  verifyGraftDir
} from './integrity';
import { parseManifest } from './manifest';
import { applyMigrations, ensureGraftRole, readMigrations } from './migrations';
import { satisfies } from './semver';
import { readSyncFailures } from './sync';

const logger = new Logger('Grafts');

const SHARED_PACKAGES = [
  /^@nestjs\//,
  /^rxjs(\/|$)/,
  /^reflect-metadata$/,
  /^@orchard\/graft-sdk(\/|$)/
];

export type LoadOptions = {
  dir?: string;
  migrate?: boolean;
  databaseUrl?: string;
  env?: NodeJS.ProcessEnv;
};

export function graftsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ORCHARD_GRAFTS_DIR ?? '/app/grafts');
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function discover(root: string): string[] {
  if (!existsSync(root)) return [];
  const present = readdirSync(root, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, 'graft.json'))
    )
    .map((e) => e.name);
  const indexPath = join(root, 'index.json');
  if (!existsSync(indexPath)) return present.sort();
  const order = (JSON.parse(readFileSync(indexPath, 'utf8')) as { order?: string[] }).order ?? [];
  return [
    ...order.filter((id) => present.includes(id)),
    ...present.filter((id) => !order.includes(id)).sort()
  ];
}

let hookedRoots: string[] = [];

function installResolutionHook(roots: string[]): void {
  const hostRequire = Module.createRequire(__filename);
  const first = hookedRoots.length === 0;
  hookedRoots = [...new Set([...hookedRoots, ...roots.map((r) => resolve(r) + sep)])];
  if (!first) return;
  const mod = Module as unknown as {
    _resolveFilename: (
      request: string,
      parent: { filename?: string } | undefined,
      ...rest: unknown[]
    ) => string;
  };
  const original = mod._resolveFilename;
  mod._resolveFilename = function (request, parent, ...rest) {
    if (
      parent?.filename &&
      hookedRoots.some((root) => parent.filename!.startsWith(root)) &&
      SHARED_PACKAGES.some((pattern) => pattern.test(request))
    ) {
      return hostRequire.resolve(request);
    }
    return original.call(this, request, parent, ...rest);
  };
}

function graftClasses(dir: string): Set<unknown> {
  const root = resolve(dir) + sep;
  const classes = new Set<unknown>();
  for (const [file, cached] of Object.entries(require.cache)) {
    if (!file.startsWith(root) || !cached?.exports) continue;
    const exports = cached.exports as Record<string, unknown>;
    for (const value of [exports, ...Object.values(exports)]) {
      if (typeof value === 'function') classes.add(value);
    }
  }
  return classes;
}

function moduleClass(mod: Type<unknown> | DynamicModule): Type<unknown> {
  return typeof mod === 'function' ? mod : mod.module;
}

function collectRoutes(
  entry: Type<unknown> | DynamicModule,
  owned: Set<unknown>,
  prefix: string
): ClassifiedRoute[] {
  const routes: ClassifiedRoute[] = [];
  const seen = new Set<unknown>();
  const visit = (mod: Type<unknown> | DynamicModule) => {
    const cls = moduleClass(mod);
    if (seen.has(cls)) return;
    seen.add(cls);
    const isDynamic = typeof mod !== 'function';
    if (!owned.has(cls) && !isDynamic) return;
    const controllers = [
      ...((Reflect.getMetadata('controllers', cls) as unknown[]) ?? []),
      ...(isDynamic ? (mod.controllers ?? []) : [])
    ];
    for (const ctrl of controllers) {
      if (isController(ctrl)) routes.push(...classifyController(ctrl, prefix));
    }
    const imports = [
      ...((Reflect.getMetadata('imports', cls) as unknown[]) ?? []),
      ...(isDynamic ? (mod.imports ?? []) : [])
    ];
    for (const imp of imports) {
      if (typeof imp === 'function' || (imp && typeof imp === 'object' && 'module' in imp)) {
        visit(imp as Type<unknown> | DynamicModule);
      }
    }
  };
  visit(entry);
  return routes;
}

function verifyRoutes(record: GraftRecord, dev: boolean): void {
  const routes = record.routes ?? [];
  const declaredPublic = new Set(
    record.manifest!.public.routes.map((r) => r.replace(/\s+/g, ' ').trim())
  );
  const undeclared = routes
    .filter((r) => r.classification === 'public')
    .map((r) => r.key)
    .filter((key) => !declaredPublic.has(key));
  if (undeclared.length) {
    throw new Error(
      `public routes not declared in graft.json public.routes: ${undeclared.join(', ')}`
    );
  }
  const routesPath = join(record.dir, 'routes.json');
  if (!existsSync(routesPath)) {
    if (dev || routes.length === 0) return;
    throw new Error('routes.json is missing; rebuild the graft with graft pack');
  }
  const expected = JSON.parse(readFileSync(routesPath, 'utf8')) as Record<string, string>;
  const actual = Object.fromEntries(routes.map((r) => [r.key, r.classification]));
  const diff = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter(
    (k) => actual[k] !== expected[k]
  );
  if (diff.length)
    throw new Error(`live routes differ from routes.json: ${diff.slice(0, 10).join(', ')}`);
}

function topoOrder(records: GraftRecord[]): void {
  const byId = new Map(records.map((r) => [r.id, r]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (record: GraftRecord, chain: string[]): void => {
    if (record.status === 'failed') return;
    const mark = state.get(record.id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      failGraft(record, 'dependencies', `dependency cycle: ${[...chain, record.id].join(' -> ')}`);
      return;
    }
    state.set(record.id, 'visiting');
    for (const [depId, range] of Object.entries(record.manifest!.requires.grafts)) {
      const dep = byId.get(depId);
      if (!dep) {
        failGraft(
          record,
          'dependencies',
          `requires graft ${depId} ${range}, which is not installed`
        );
        break;
      }
      visit(dep, [...chain, record.id]);
      if (dep.status === 'failed') {
        failGraft(record, 'dependencies', `requires graft ${depId}, which failed to load`);
        break;
      }
      if (!satisfies(dep.manifest!.version, range)) {
        failGraft(
          record,
          'dependencies',
          `requires graft ${depId} ${range}, found ${dep.manifest!.version}`
        );
        break;
      }
    }
    state.set(record.id, 'done');
  };
  for (const record of records) visit(record, []);
}

function uiDigest(dir: string): string | undefined {
  const uiRoot = join(dir, 'ui');
  if (!existsSync(uiRoot)) return undefined;
  const hash = createHash('sha256');
  for (const file of listFiles(uiRoot)) hash.update(file).update(sha256File(join(uiRoot, file)));
  return hash.digest('hex').slice(0, 16);
}

export async function loadGrafts(options: LoadOptions = {}): Promise<GraftRecord[]> {
  const env = options.env ?? process.env;
  const root = options.dir ?? graftsDir(env);
  if (truthy(env.ORCHARD_GRAFTS_SAFE_MODE)) {
    logger.warn('ORCHARD_GRAFTS_SAFE_MODE is set; no grafts are loaded');
    setGraftRecords([]);
    return [];
  }
  const ids = discover(root);
  const syncFailures = readSyncFailures(root).filter((f) => !ids.includes(f.id));
  if (ids.length === 0 && syncFailures.length === 0) {
    setGraftRecords([]);
    return [];
  }
  const dev = truthy(env.ORCHARD_GRAFTS_DEV);
  const policy = trustPolicyFromEnv(env);
  const keys = publisherKeysFromEnv(env);
  const platform = platformVersion();
  if (dev) logger.warn('ORCHARD_GRAFTS_DEV is set; graft integrity checks are skipped');

  const records: GraftRecord[] = ids.map((id) => ({
    id,
    dir: realpathSync(join(root, id)),
    status: 'loaded',
    warnings: []
  }));

  for (const record of records) {
    try {
      record.manifest = parseManifest(
        JSON.parse(readFileSync(join(record.dir, 'graft.json'), 'utf8'))
      );
      if (record.manifest.id !== record.id)
        throw new Error(
          `graft.json id "${record.manifest.id}" does not match directory "${record.id}"`
        );
    } catch (err) {
      failGraft(record, 'manifest', (err as Error).message);
      continue;
    }
    try {
      record.signature = dev
        ? { signedBy: null, keyId: null }
        : verifyGraftDir(record.dir, policy, keys);
    } catch (err) {
      failGraft(record, 'integrity', (err as Error).message);
      continue;
    }
    const m = record.manifest;
    const problems: string[] = [];
    if (!satisfies(platform, m.engines.platform))
      problems.push(`needs Orchard ${m.engines.platform}, this is ${platform}`);
    if (!satisfies(GRAFT_SDK_VERSION, m.engines.sdk))
      problems.push(`needs graft SDK ${m.engines.sdk}, this Orchard provides ${GRAFT_SDK_VERSION}`);
    const missing = missingDoors(m.uses);
    if (missing.length)
      problems.push(`uses doors this Orchard does not provide: ${missing.join(', ')}`);
    if (problems.length) {
      failGraft(record, 'compat', problems.join('; '));
      continue;
    }
    const deprecated = deprecatedDoors(m.uses);
    if (deprecated.length) record.warnings.push(`uses deprecated doors: ${deprecated.join(', ')}`);
  }

  topoOrder(records);

  const live = records.filter((r) => r.status === 'loaded');
  const claims = resolveClaims(live.map((r) => r.manifest!));
  for (const record of live) {
    record.claims = claims.get(record.id);
    for (const claim of record.claims ?? []) {
      if (claim.state === 'shadowed')
        record.warnings.push(`${claim.kind} ${claim.value} is shadowed by ${claim.shadowedBy}`);
    }
  }

  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (
    options.migrate !== false &&
    databaseUrl &&
    live.some(
      (r) => readMigrations(r.dir).length || Object.keys(r.manifest!.database.coreReads).length
    )
  ) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      for (const record of live) {
        if (record.status === 'failed') continue;
        try {
          const result = await applyMigrations(client, record.id, readMigrations(record.dir));
          record.migrationsApplied = result.applied;
          record.dbRole = await ensureGraftRole(
            client,
            record.id,
            record.manifest!.database.coreReads
          );
          if (record.dbRole === null)
            record.warnings.push(
              'database user cannot create roles; the graft shares the main database user'
            );
          if (result.applied.length)
            logger.log(`${record.id}: applied migrations ${result.applied.join(', ')}`);
        } catch (err) {
          failGraft(record, 'migrations', (err as Error).message);
        }
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  installResolutionHook(live.map((r) => r.dir));
  for (const record of live) {
    if (record.status === 'failed') continue;
    const entry = record.manifest!.entries.server;
    record.uiDigest = record.manifest!.entries.ui ? uiDigest(record.dir) : undefined;
    if (!entry) continue;
    try {
      const exported = require(join(record.dir, entry)) as Record<string, unknown>;
      const mod = (exported.default ?? exported.GraftModule) as
        | Type<unknown>
        | DynamicModule
        | undefined;
      if (!mod || (typeof mod !== 'function' && !(typeof mod === 'object' && 'module' in mod))) {
        throw new Error(`${entry} must export a Nest module as default or GraftModule`);
      }
      record.module = mod;
      record.routes = collectRoutes(mod, graftClasses(record.dir), '');
    } catch (err) {
      failGraft(record, 'load', (err as Error).message);
      continue;
    }
    try {
      verifyRoutes(record, dev);
    } catch (err) {
      failGraft(record, 'routes', (err as Error).message);
    }
  }

  for (const failure of syncFailures) {
    records.push({
      id: failure.id,
      dir: join(root, failure.id),
      status: 'failed',
      phase: 'sync',
      reason: failure.reason,
      warnings: []
    });
  }

  for (const record of records) {
    if (record.status === 'failed')
      logger.error(`${record.id} failed during ${record.phase}: ${record.reason}`);
    else
      logger.log(
        `${record.id}@${record.manifest!.version} loaded${record.warnings.length ? ` (${record.warnings.join('; ')})` : ''}`
      );
  }

  const failed = records.filter((r) => r.status === 'failed');
  if (failed.length && truthy(env.ORCHARD_GRAFTS_STRICT)) {
    throw new Error(
      `ORCHARD_GRAFTS_STRICT: ${failed.map((r) => `${r.id} (${r.phase}: ${r.reason})`).join('; ')}`
    );
  }
  setGraftRecords(records);
  return records;
}
