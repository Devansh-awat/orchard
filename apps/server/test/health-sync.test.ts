import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const strip = (s: string) => s.replace(/^\/\/ generated[^\n]*\n/, '').replace(/[\s,;]+/g, '');

test('the server copy of computeHealth matches packages/health', () => {
  const canonical = readFileSync(resolve(root, 'packages/health/src/health.ts'), 'utf8');
  const copy = readFileSync(resolve(root, 'apps/server/src/health/health.generated.ts'), 'utf8');
  assert.equal(
    strip(copy),
    strip(canonical),
    'run `tsx packages/health/scripts/sync.ts` and format the server copy'
  );
});
