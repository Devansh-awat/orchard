import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInventory, readSnapshot } from './inventory';
import { mergeMatrix, readMatrix, summarize, validateMatrix, writeMatrix } from './matrix';

test('the route inventory matches the auth-coverage snapshot', async () => {
  const { routes, conflicts } = await buildInventory();
  assert.equal(conflicts.length, 0, conflicts.join('\n'));
  const snapshot = readSnapshot();
  const inventoried = new Set(routes.map((route) => route.key));
  const missing = Object.keys(snapshot).filter((key) => !inventoried.has(key));
  const extra = [...inventoried].filter((key) => !(key in snapshot));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'The inventory and test/auth-coverage.snapshot.json must list the same routes. Regenerate the snapshot first (UPDATE_SNAPSHOT=1 pnpm test:auth-coverage).'
  );
  for (const route of routes) {
    assert.equal(route.auth, snapshot[route.key], `${route.key}: auth class differs from snapshot`);
  }
});

test('every route has an isolation decision in isolation-matrix.json', async () => {
  const { routes } = await buildInventory();
  const previous = readMatrix();
  if (process.env.UPDATE_ISOLATION_MATRIX === '1') {
    const next = mergeMatrix(routes, previous, process.env.ISOLATION_ACCEPT_PROPOSED === '1');
    writeMatrix(next);
    console.log(`wrote ${Object.keys(next).length} routes`, summarize(next));
  }
  const problems = validateMatrix(routes, readMatrix());
  assert.deepEqual(
    problems,
    [],
    `\n${problems.join('\n')}\n\nAdd or fix the entry in apps/server/test/isolation/isolation-matrix.json.\nUPDATE_ISOLATION_MATRIX=1 pnpm test:isolation:matrix adds new routes as "unclassified"; set each one's class by hand (see docs/isolation-testing.md).`
  );
});
