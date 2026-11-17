import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_CACHE_PURPOSE } from '../src/docker/build-cache-s3';

const repo = resolve(__dirname, '../../..');
const proxy = readFileSync(resolve(repo, 'apps/r2-proxy/main.go'), 'utf8');
const service = readFileSync(resolve(repo, 'apps/server/src/prisma/prisma.service.ts'), 'utf8');

function grantedKeyColumns(): string[] {
  const grant = service.match(/GRANT SELECT \(([^)]+)\)\s+ON TABLE storage_access_keys/);
  assert.ok(grant, 'storage_access_keys is granted by column');
  return grant[1].split(',').map((column) => column.trim());
}

test('the backup proxy role can read every scoped key column the proxy selects', () => {
  const start = proxy.indexOf('func (s *bindingStore) lookupScoped');
  const query = proxy.slice(start, proxy.indexOf('LIMIT 1', start));
  const used = [...new Set([...query.matchAll(/\bk\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(used.includes('secret'));
  assert.deepEqual([...used].sort(), [...grantedKeyColumns()].sort());
});

test('the backup proxy role gets no key columns beyond those', () => {
  const granted = grantedKeyColumns();
  for (const column of ['organization_id', 'operation_id', 'created_at']) {
    assert.ok(!granted.includes(column), `${column} stays private`);
  }
});

test('every purpose the server gives a scoped key binds it to buckets in the proxy', () => {
  assert.equal(proxy.match(/const buildCachePurpose = "([^"]+)"/)?.[1], BUILD_CACHE_PURPOSE);
  assert.match(proxy, /strings\.HasPrefix\(purpose, "database-"\)/);
  for (const file of ['database-operations.service.ts', 'database-trash.service.ts']) {
    const source = readFileSync(resolve(repo, 'apps/server/src/projects', file), 'utf8');
    const purposes = [...source.matchAll(/purpose: [`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
    assert.ok(purposes.length > 0, `${file} mints scoped keys`);
    for (const purpose of purposes) {
      assert.ok(purpose.startsWith('database-'), `${file}: ${purpose}`);
    }
  }
});
