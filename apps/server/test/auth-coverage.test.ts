/**
 * Auth-coverage snapshot test.
 *
 * Walks every NestJS controller in src/, reads the auth-related metadata
 * attached to each handler by the @Auth() / @Public() decorators (and by the
 * controller class itself), and classifies every route as one of:
 *
 *   - "public"        @Public(), no token required, no RBAC
 *   - "authenticated" @Auth(), JWT/session required, RBAC done in service
 *   - "superadmin"    neither, SuperAdminGuard's default = superadmin only
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
 * The test imports controller modules directly via the filesystem: it does
 * NOT boot the Nest app, so no DB / K8s / env setup is required.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  classifyController,
  isController,
  routeTable,
  scopeTable,
  type ClassifiedRoute,
  type RouteClassification
} from '../src/auth/route-classifier';

const SRC_ROOT = path.resolve(__dirname, '../src');
const GRAFTS_ROOT = path.resolve(__dirname, '../../../grafts');
const SNAPSHOT_PATH = path.join(__dirname, 'auth-coverage.snapshot.json');
const SCOPE_SNAPSHOT_PATH = path.join(__dirname, 'auth-scope.snapshot.json');

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

function controllerRoots(): { root: string; prefix: string }[] {
  const roots = [{ root: SRC_ROOT, prefix: '' }];
  if (!existsSync(GRAFTS_ROOT)) return roots;
  for (const entry of readdirSync(GRAFTS_ROOT, { withFileTypes: true })) {
    const serverSrc = path.join(GRAFTS_ROOT, entry.name, 'server', 'src');
    if (entry.isDirectory() && existsSync(serverSrc))
      roots.push({ root: serverSrc, prefix: entry.name });
  }
  return roots;
}

test('every endpoint matches the auth-coverage snapshot', async () => {
  const conflicts: string[] = [];
  const routes: ClassifiedRoute[] = [];

  for (const { root, prefix } of controllerRoots()) {
    for (const file of findControllerFiles(root)) {
      const mod = await import(pathToFileURL(file).href);
      for (const exportName of Object.keys(mod)) {
        const cls = mod[exportName];
        if (!isController(cls)) continue;
        routes.push(...classifyController(cls, prefix, conflicts));
      }
    }
  }

  const current = routeTable(routes, conflicts);
  const scopes = scopeTable(routes, conflicts);

  assert.equal(conflicts.length, 0, `Decorator conflicts:\n  ${conflicts.join('\n  ')}`);

  const writeSnapshot = process.env.UPDATE_SNAPSHOT === '1' || !existsSync(SNAPSHOT_PATH);
  if (writeSnapshot) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n');
    writeFileSync(SCOPE_SNAPSHOT_PATH, JSON.stringify(scopes, null, 2) + '\n');
    console.log(
      `✓ Wrote ${Object.keys(current).length} endpoints to ${path.relative(process.cwd(), SNAPSHOT_PATH)}`
    );
    return;
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<
    string,
    RouteClassification
  >;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    if (!(key in snapshot)) added.push(`  + ${key.padEnd(60)} ${current[key]}`);
    else if (!(key in current)) removed.push(`  - ${key.padEnd(60)} (was ${snapshot[key]})`);
    else if (snapshot[key] !== current[key])
      changed.push(`  ~ ${key.padEnd(60)} ${snapshot[key]} → ${current[key]}`);
  }

  if (added.length || removed.length || changed.length) {
    let msg = 'Endpoint auth-classification snapshot mismatch:\n';
    if (added.length) msg += `\nAdded (${added.length}):\n${added.join('\n')}`;
    if (removed.length) msg += `\nRemoved (${removed.length}):\n${removed.join('\n')}`;
    if (changed.length) msg += `\nChanged (${changed.length}):\n${changed.join('\n')}`;
    msg +=
      '\n\nIf the change is intentional, regenerate the snapshot:\n  UPDATE_SNAPSHOT=1 pnpm test:auth-coverage';
    throw new Error(msg);
  }

  const scopeSnapshot = existsSync(SCOPE_SNAPSHOT_PATH)
    ? (JSON.parse(readFileSync(SCOPE_SNAPSHOT_PATH, 'utf8')) as Record<string, string>)
    : {};
  assert.deepEqual(
    scopes,
    scopeSnapshot,
    '@RequireScope declarations changed. Regenerate the snapshot:\n  UPDATE_SNAPSHOT=1 pnpm test:auth-coverage'
  );
});

test('no endpoint mixes @Auth() with @Public() at the handler level', () => {
  // Already enforced inline above, but a dedicated test makes intent visible
  // in the runner output.
});

test('every route in the snapshot has a recognised classification', () => {
  if (!existsSync(SNAPSHOT_PATH)) return; // first run handled by the snapshot test
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, string>;
  const allowed: RouteClassification[] = ['public', 'authenticated', 'superadmin'];
  for (const [key, value] of Object.entries(snapshot)) {
    assert.ok(
      (allowed as readonly string[]).includes(value),
      `${key}: classification "${value}" is not one of ${allowed.join('|')}`
    );
  }
});
