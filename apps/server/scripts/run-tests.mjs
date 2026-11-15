import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const postgres = new Set([
  'test/apply-queue.test.ts',
  'test/engine-informer.test.ts',
  'test/github-repo-link.test.ts',
  'test/rate-limit-postgres.test.ts'
]);

const separate = new Set(['test/isolation/replay.test.ts']);

const group = process.argv[2] ?? 'unit';
if (group !== 'unit' && group !== 'postgres') {
  console.error(`unknown test group ${group}, expected unit or postgres`);
  process.exit(2);
}

const files = readdirSync(join(root, 'test'), { recursive: true })
  .map((file) => join('test', file).split('\\').join('/'))
  .filter((file) => file.endsWith('.test.ts') && !separate.has(file))
  .filter((file) => postgres.has(file) === (group === 'postgres'))
  .sort();

const result = spawnSync('tsx', ['--test', ...process.argv.slice(3), ...files], {
  cwd: root,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
