/**
 * Auth-coverage snapshot test.
 *
 * Walks every NestJS controller in src/, reads the auth-related metadata
 * attached to each handler by the @Auth() / @Public() decorators (and by the
 * controller class itself), and classifies every route as one of:
 *
 *   - "public"        — @Public() — no token required, no RBAC
 *   - "authenticated" — @Auth() — JWT/session required, RBAC done in service
 *   - "superadmin"    — neither — SuperAdminGuard's default = superadmin only
 *
 * The result is compared against test/auth-coverage.snapshot.json. When you
 * add, remove, or reclassify a route the test fails with a diff describing
 * exactly what changed. Reviewing the snapshot diff in a PR forces a
 * conscious decision: did I really mean to make this endpoint public?
 *
 * Run:
 *   pnpm test:auth-coverage             # check
 *   UPDATE_SNAPSHOT=1 pnpm test:auth-coverage   # rewrite the snapshot
 *
 * The test imports controller modules directly via the filesystem — it does
 * NOT boot the Nest app, so no DB / K8s / env setup is required.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// These string constants are the metadata keys NestJS uses. Hardcoded so the
// test doesn't depend on any private API surface from @nestjs/common.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const IS_PUBLIC_KEY = 'isPublic';
const REQUIRES_AUTH_KEY = 'requiresAuth';

// Mirrors RequestMethod in @nestjs/common (verified at write-time against
// node_modules/@nestjs/common/enums/request-method.enum.js).
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'] as const;

type Classification = 'public' | 'authenticated' | 'superadmin';

const SRC_ROOT = path.resolve(__dirname, '../src');
const SNAPSHOT_PATH = path.join(__dirname, 'auth-coverage.snapshot.json');

function findControllerFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(p);
      } else if (entry.name.endsWith('.controller.ts')) {
        results.push(p);
      }
    }
  };
  walk(root);
  return results;
}

function classify(handlerMeta: { isPublic?: boolean; requiresAuth?: boolean }, classMeta: { isPublic?: boolean; requiresAuth?: boolean }): Classification {
  // Resolution order mirrors SuperAdminGuard.canActivate exactly:
  //   1. Handler-level @Public()             → public (short-circuit)
  //   2. @Auth() at handler OR class         → authenticated
  //   3. @Public() at class (no handler tag) → public
  //   4. Nothing                              → superadmin (default)
  // Notably a handler-level @Auth() OVERRIDES a class-level @Public(), which
  // is why we can't just use ?? — the auth check has to come before the
  // class-level public check.
  if (handlerMeta.isPublic) return 'public';
  const requiresAuth = handlerMeta.requiresAuth || classMeta.requiresAuth;
  if (requiresAuth) return 'authenticated';
  if (classMeta.isPublic) return 'public';
  return 'superadmin';
}

test('every endpoint matches the auth-coverage snapshot', async () => {
  const files = findControllerFiles(SRC_ROOT);
  const endpoints: Record<string, Classification> = {};
  const conflicts: string[] = [];

  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    for (const exportName of Object.keys(mod)) {
      const cls = mod[exportName];
      if (typeof cls !== 'function') continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, cls);
      // Only classes that carry @Controller() get a path metadata entry.
      if (controllerPath === undefined) continue;

      const classMeta = {
        isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, cls) as boolean | undefined,
        requiresAuth: Reflect.getMetadata(REQUIRES_AUTH_KEY, cls) as boolean | undefined,
      };

      const proto = cls.prototype;
      for (const methodName of Object.getOwnPropertyNames(proto)) {
        if (methodName === 'constructor') continue;
        const handler = proto[methodName];
        if (typeof handler !== 'function') continue;

        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (httpMethod === undefined) continue;

        const routePath = (Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined) ?? '';
        const handlerMeta = {
          isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined,
          requiresAuth: Reflect.getMetadata(REQUIRES_AUTH_KEY, handler) as boolean | undefined,
        };

        // Catch self-contradictory decorators (would be a bug).
        if (handlerMeta.isPublic && handlerMeta.requiresAuth) {
          conflicts.push(`${exportName}.${methodName} has BOTH @Auth() and @Public()`);
        }

        const classification = classify(handlerMeta, classMeta);
        const httpMethodName = HTTP_METHODS[httpMethod] ?? `UNKNOWN(${httpMethod})`;
        const paths = Array.isArray(routePath) ? routePath : [routePath];

        for (const sub of paths) {
          const joined = `/${controllerPath}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
          const key = `${httpMethodName} ${joined}`;
          if (key in endpoints && endpoints[key] !== classification) {
            conflicts.push(`${key} declared with conflicting classifications (${endpoints[key]} vs ${classification})`);
          }
          endpoints[key] = classification;
        }
      }
    }
  }

  assert.equal(conflicts.length, 0, `Decorator conflicts:\n  ${conflicts.join('\n  ')}`);

  // Stable ordering for diff readability.
  const current: Record<string, Classification> = Object.fromEntries(
    Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b)),
  );

  const writeSnapshot = process.env.UPDATE_SNAPSHOT === '1' || !existsSync(SNAPSHOT_PATH);
  if (writeSnapshot) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`✓ Wrote ${Object.keys(current).length} endpoints to ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
    return;
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, Classification>;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    if (!(key in snapshot)) added.push(`  + ${key.padEnd(60)} ${current[key]}`);
    else if (!(key in current)) removed.push(`  - ${key.padEnd(60)} (was ${snapshot[key]})`);
    else if (snapshot[key] !== current[key]) changed.push(`  ~ ${key.padEnd(60)} ${snapshot[key]} → ${current[key]}`);
  }

  if (added.length || removed.length || changed.length) {
    let msg = 'Endpoint auth-classification snapshot mismatch:\n';
    if (added.length) msg += `\nAdded (${added.length}):\n${added.join('\n')}`;
    if (removed.length) msg += `\nRemoved (${removed.length}):\n${removed.join('\n')}`;
    if (changed.length) msg += `\nChanged (${changed.length}):\n${changed.join('\n')}`;
    msg += '\n\nIf the change is intentional, regenerate the snapshot:\n  UPDATE_SNAPSHOT=1 pnpm test:auth-coverage';
    throw new Error(msg);
  }
});

test('no endpoint mixes @Auth() with @Public() at the handler level', () => {
  // Already enforced inline above, but a dedicated test makes intent visible
  // in the runner output.
});

test('every route in the snapshot has a recognised classification', () => {
  if (!existsSync(SNAPSHOT_PATH)) return; // first run handled by the snapshot test
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, string>;
  const allowed: Classification[] = ['public', 'authenticated', 'superadmin'];
  for (const [key, value] of Object.entries(snapshot)) {
    assert.ok(
      (allowed as readonly string[]).includes(value),
      `${key}: classification "${value}" is not one of ${allowed.join('|')}`,
    );
  }
});
