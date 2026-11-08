import 'reflect-metadata';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InventoryRoute } from './inventory';
import { isTenantKind } from './kinds';
import { readMatrix, routeFromMatrix } from './matrix';
import { bootHarness, type Harness } from './harness';
import { buildPrincipals, type Principal } from './principals';
import { Snapshotter } from './snapshot';
import {
  buildForbidden,
  buildRequest,
  bucketOf,
  runRoute,
  send,
  type Finding,
  type Probe,
  type RouteRunContext
} from './replay';
import { seedWorld, tagOf, teardownWorld, type World } from './world';

const EXCEPTIONS_PATH = path.resolve(__dirname, 'isolation-exceptions.json');
const ONLY = process.env.ISOLATION_ONLY ? new RegExp(process.env.ISOLATION_ONLY) : null;

type ExceptionEntry = { id: string; status: 'open' | 'accepted'; reason: string };

function readExceptions(): ExceptionEntry[] {
  try {
    return JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8')).findings as ExceptionEntry[];
  } catch {
    return [];
  }
}

const matrix = readMatrix();
const replayKeys = Object.keys(matrix).filter(
  (key) => matrix[key].class === 'resource-scoped' || matrix[key].class === 'own-scope-only'
);
const superadminKeys = Object.keys(matrix).filter(
  (key) => matrix[key].class === 'superadmin' && !/^(ALL|OPTIONS|HEAD) /.test(key)
);

let harness: Harness;
let world: World;
let principals: Principal[];
let ctx: RouteRunContext;
let routes: Map<string, InventoryRoute>;
const controls: { route: string; status: number; bucket: string }[] = [];
const allFindings: Finding[] = [];
const allProbes: { route: string; class: string; probes: Probe[] }[] = [];
const seenExceptionIds = new Set<string>();

before(async () => {
  harness = await bootHarness();
  world = await seedWorld(harness.prisma, harness.secret, tagOf());
  principals = await buildPrincipals(harness.prisma, world);
  const snapshotter = new Snapshotter(harness.prisma);
  const allMarkers = [
    ...Object.values(world.orgs).flatMap((org) => org.markers),
    ...Object.values(world.projects).flatMap((project) => project.markers)
  ];
  const resourceMarkers = [
    ...Object.values(world.orgs).flatMap((org) => org.markers.slice(0, 3)),
    ...Object.values(world.projects).flatMap((project) => project.markers)
  ];
  ctx = {
    baseUrl: harness.baseUrl,
    world,
    principals,
    snapshotter,
    state: { snapshot: await snapshotter.take() },
    forbidden: buildForbidden(world, principals),
    allMarkers,
    resourceMarkers
  };
  routes = new Map(
    Object.entries(matrix).map(([key, entry]) => [key, routeFromMatrix(key, entry)])
  );
});

after(async () => {
  if (process.env.ISOLATION_REPORT) {
    writeFileSync(
      process.env.ISOLATION_REPORT,
      JSON.stringify({ findings: allFindings, probes: allProbes, controls }, null, 2)
    );
  }
  if (world) await teardownWorld(harness.prisma, world);
  await harness?.close();
});

function judge(found: Finding[]): Finding[] {
  const allow = new Map(readExceptions().map((entry) => [entry.id, entry]));
  return found.filter((finding) => {
    seenExceptionIds.add(finding.id);
    return !allow.has(finding.id);
  });
}

function describeFindings(found: Finding[]): string {
  return found
    .map(
      (f) =>
        `  [${f.kind}] ${f.principal} (${f.variant}) -> ${f.status}\n    ${f.request.slice(0, 220)}\n    ${f.detail}\n    id: ${f.id}`
    )
    .join('\n');
}

describe('replay resource-scoped and own-scope-only routes as foreign principals', () => {
  for (const key of replayKeys) {
    if (ONLY && !ONLY.test(key)) continue;
    test(key, async () => {
      const route = routes.get(key);
      assert.ok(route, `${key} is in the matrix but not in the route inventory`);
      const cls = matrix[key].class as 'resource-scoped' | 'own-scope-only';
      const { findings, probes } = await runRoute(route, cls, ctx);
      allFindings.push(...findings);
      allProbes.push({ route: key, class: cls, probes });
      const unexplained = judge(findings);
      assert.equal(
        unexplained.length,
        0,
        `\n${describeFindings(unexplained)}\n\nIf this is a real cross-tenant problem, fix the route. If it is a reviewed false positive, add its id to isolation-exceptions.json with a reason.`
      );
    });
  }
});

describe('superadmin routes refuse every tenant principal', () => {
  for (const key of superadminKeys) {
    if (ONLY && !ONLY.test(key)) continue;
    test(key, async () => {
      const route = routes.get(key);
      assert.ok(route, `${key} is in the matrix but not in the route inventory`);
      const found: Finding[] = [];
      const wall = ctx.principals.filter(
        (principal) =>
          principal.relation === 'anon' ||
          principal.relation === 'cross-org' ||
          principal.relation === 'owner'
      );
      for (const principal of wall) {
        const victim = {
          org: world.orgs[principal.victim.orgKey],
          project: world.projects[principal.victim.projectKey],
          user: world.users[principal.victim.orgKey === 'o1' ? 'o1Owner' : 'o2Owner']
        };
        const built = buildRequest(route, 'foreign', victim, null, world);
        if (!built) continue;
        const outcome = await send(harness.baseUrl, built, principal.headers);
        const bucket = bucketOf(outcome);
        if (bucket !== 'denied') {
          found.push({
            id: `superadmin-open | ${key} | ${principal.key}`,
            kind: 'allowed',
            route: key,
            principal: principal.key,
            variant: 'foreign',
            status: outcome.status,
            detail: `a non-superadmin got ${outcome.status}: ${outcome.text.slice(0, 160)}`,
            request: built.label
          });
        }
      }
      allFindings.push(...found);
      const unexplained = judge(found);
      assert.equal(unexplained.length, 0, `\n${describeFindings(unexplained)}`);
    });
  }
});

describe('the legitimate owner reaches every resource-scoped route (the denials above are not vacuous)', () => {
  const scopedKeys = replayKeys.filter(
    (key) =>
      matrix[key].class === 'resource-scoped' &&
      matrix[key].params.some((param) => isTenantKind(param.split(':')[1]))
  );
  for (const key of scopedKeys) {
    if (ONLY && !ONLY.test(key)) continue;
    test(key, async () => {
      const route = routes.get(key)!;
      const mutating = route.method !== 'GET';
      const target = mutating ? await seedWorld(harness.prisma, harness.secret, tagOf()) : world;
      try {
        const owner = target.users.o1Owner;
        const built = buildRequest(
          route,
          'foreign',
          {
            org: target.orgs.o1,
            project: target.projects.p1,
            user: owner
          },
          null,
          target
        );
        assert.ok(built, 'request could not be built');
        const outcome = await send(harness.baseUrl, built, {
          authorization: `Bearer ${owner.jwt}`
        });
        controls.push({ route: key, status: outcome.status, bucket: bucketOf(outcome) });
      } finally {
        if (mutating) await teardownWorld(harness.prisma, target);
      }
    });
  }

  test('harness health: owners reach most routes, anonymous callers reach none', () => {
    if (ONLY) return;
    const reached = controls.filter((control) => control.bucket !== 'denied').length;
    const ratio = reached / Math.max(controls.length, 1);
    console.log(
      `owner control: ${reached}/${controls.length} routes reached the handler (${Math.round(ratio * 100)}%)`
    );
    assert.ok(
      ratio > 0.6,
      `only ${Math.round(ratio * 100)}% of routes were reachable by their own owner`
    );
  });
});

describe('exceptions file', () => {
  test('every entry still matches a finding', () => {
    if (ONLY) return;
    const stale = readExceptions().filter((entry) => !seenExceptionIds.has(entry.id));
    assert.deepEqual(
      stale.map((entry) => entry.id),
      [],
      'These isolation-exceptions.json entries no longer fire. Remove them so the allowlist cannot rot.'
    );
  });
});
