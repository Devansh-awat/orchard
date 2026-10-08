import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDefaultLocalDatabase, resolveTestDatabase } from './support/test-database';

const none: string[] = [];

test('DB-backed tests refuse localhost:5432 and a missing database', () => {
  for (const url of [
    'postgresql://orchard:orchard@localhost:5432/orchard',
    'postgresql://orchard@127.0.0.1/orchard',
    'postgres://u:p@[::1]:5432/db'
  ]) {
    assert.equal(isDefaultLocalDatabase(url), true, url);
    const db = resolveTestDatabase({ DATABASE_URL: url }, none);
    assert.ok('refused' in db && /localhost:5432/.test(db.refused), url);
  }
  const missing = resolveTestDatabase({}, none);
  assert.ok('refused' in missing && /TEST_DATABASE_URL/.test(missing.refused));
});

test('DB-backed tests accept TEST_DATABASE_URL or a non-default DATABASE_URL', () => {
  assert.deepEqual(
    resolveTestDatabase(
      {
        TEST_DATABASE_URL: 'postgresql://t@localhost:5432/scratch',
        DATABASE_URL: 'postgresql://orchard@localhost:5432/orchard'
      },
      none
    ),
    { url: 'postgresql://t@localhost:5432/scratch', source: 'TEST_DATABASE_URL' }
  );
  const ok = resolveTestDatabase({ DATABASE_URL: 'postgresql://t@127.0.0.1:15432/t' }, none);
  assert.ok('url' in ok && ok.url.endsWith(':15432/t'));
});

test('the guard reads DATABASE_URL from .env the way Prisma would', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-envguard-'));
  const file = join(dir, '.env');
  writeFileSync(
    file,
    'FOO=1\nDATABASE_URL="postgresql://orchard:orchard@localhost:5432/orchard"\n'
  );
  const db = resolveTestDatabase({}, [file]);
  assert.ok('refused' in db && db.refused.includes(file));
});
