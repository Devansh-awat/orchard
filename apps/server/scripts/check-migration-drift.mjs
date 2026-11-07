import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadGraftOwned(path = join(root, 'prisma', 'graft-owned.json')) {
  const { tables, enums } = JSON.parse(readFileSync(path, 'utf8'));
  return { tables: new Set(tables), enums: new Set(enums) };
}

export function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function unexpectedStatements(sql, owned = loadGraftOwned()) {
  return statements(sql).filter((s) => {
    let m = /^DROP TABLE "public"\."([^"]+)"$/.exec(s);
    if (m) return !owned.tables.has(m[1]);
    m = /^ALTER TABLE "public"\."([^"]+)" DROP CONSTRAINT "[^"]+"$/.exec(s);
    if (m) return !owned.tables.has(m[1]);
    m = /^DROP TYPE "public"\."([^"]+)"$/.exec(s);
    if (m) return !owned.enums.has(m[1]);
    return true;
  });
}

export function ownedDrops(sql, owned = loadGraftOwned()) {
  return statements(sql).filter((s) => {
    let m = /^DROP TABLE (?:IF EXISTS )?(?:"public"\.)?"([^"]+)"/.exec(s);
    if (m) return owned.tables.has(m[1]);
    m = /^DROP TYPE (?:IF EXISTS )?(?:"public"\.)?"([^"]+)"/.exec(s);
    if (m) return owned.enums.has(m[1]);
    return false;
  });
}

function committedOwnedDrops() {
  const dir = join(root, 'prisma', 'migrations');
  const found = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) continue;
    for (const s of ownedDrops(readFileSync(file, 'utf8'))) found.push(`${name}: ${s}`);
  }
  return found;
}

function diffArgs(env) {
  const base = ['migrate', 'diff', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'];
  if (env.SHADOW_DATABASE_URL) {
    return [
      ...base,
      '--from-migrations',
      'prisma/migrations',
      '--shadow-database-url',
      env.SHADOW_DATABASE_URL
    ];
  }
  if (env.DATABASE_URL) return [...base, '--from-url', env.DATABASE_URL];
  throw new Error(
    'set SHADOW_DATABASE_URL (an empty scratch database) or DATABASE_URL (a database with every migration applied)'
  );
}

function main() {
  const prisma = createRequire(join(root, 'package.json')).resolve('prisma/build/index.js');
  const sql = execFileSync(process.execPath, [prisma, ...diffArgs(process.env)], {
    cwd: root,
    encoding: 'utf8',
    env: process.env
  });
  const dropped = committedOwnedDrops();
  if (dropped.length > 0) {
    console.error(
      'a migration drops a table or enum that a graft owns; its data lives there (see prisma/graft-owned.json):\n'
    );
    for (const s of dropped) console.error(`${s};\n`);
    process.exit(1);
  }
  const bad = unexpectedStatements(sql);
  if (bad.length === 0) {
    console.log('migrations match schema.prisma');
    return;
  }
  console.error(
    'schema.prisma and prisma/migrations have drifted. Statements prisma would still emit:\n'
  );
  for (const s of bad) console.error(`${s};\n`);
  console.error(
    'Create a migration with `pnpm --filter server prisma:migrate -- --create-only` and review it. Never drop tables listed in prisma/graft-owned.json.'
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
