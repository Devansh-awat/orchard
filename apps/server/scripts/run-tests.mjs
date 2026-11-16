import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..', '..');

const postgres = new Set([
  'test/apply-queue.test.ts',
  'test/engine-informer.test.ts',
  'test/github-repo-link.test.ts',
  'test/rate-limit-postgres.test.ts'
]);

const separate = new Set(['test/isolation/replay.test.ts']);

const scope = [
  'apps/server/',
  'packages/contracts/',
  'packages/health/',
  'packages/graft-sdk/',
  'grafts/'
];
const ignored = [/\.md$/, /^grafts\/[^/]+\/ui\//, /\.(svelte|css)$/];
const code = /\.(ts|mts|cts|js|mjs|cjs)$/;
const selector = 'apps/server/scripts/run-tests.mjs';

const group = process.argv[2] ?? 'unit';
if (group !== 'unit' && group !== 'postgres') {
  console.error(`unknown test group ${group}, expected unit or postgres`);
  process.exit(2);
}

const all = readdirSync(join(root, 'test'), { recursive: true })
  .map((file) => join('test', file).split('\\').join('/'))
  .filter((file) => file.endsWith('.test.ts') && !separate.has(file))
  .filter((file) => postgres.has(file) === (group === 'postgres'))
  .sort();

const nodeModules = {
  name: 'node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.inner) return undefined;
      if (args.path.startsWith('node:')) return { external: true };
      const found = await b.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { inner: true }
      });
      if (
        found.errors.length > 0 ||
        !isAbsolute(found.path) ||
        found.path.includes(`${sep}node_modules${sep}`)
      ) {
        return { external: true };
      }
      return { path: found.path };
    });
  }
};

async function inputsOf(file) {
  const result = await build({
    entryPoints: [join(root, file)],
    absWorkingDir: repo,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [nodeModules],
    loader: { '.node': 'empty', '.mjml': 'text', '.sql': 'text', '.yaml': 'text', '.txt': 'text' }
  });
  return new Set(Object.keys(result.metafile.inputs));
}

async function pool(items, size, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function affected(base) {
  const changed = execFileSync('git', ['diff', '--name-only', base], {
    cwd: repo,
    encoding: 'utf8'
  })
    .split('\n')
    .filter((file) => file && scope.some((prefix) => file.startsWith(prefix)))
    .filter((file) => !ignored.some((pattern) => pattern.test(file)));

  const wide = changed.filter((file) => file === selector || !code.test(file));
  if (wide.length > 0) {
    console.log(`running every ${group} test, because these changed: ${wide.join(', ')}`);
    return all;
  }
  if (changed.length === 0) return [];

  const picked = await pool(all, 16, async (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    if (changed.some((path) => path === `apps/server/${file}` || source.includes(path))) {
      return file;
    }
    try {
      const inputs = await inputsOf(file);
      return changed.some((path) => inputs.has(path)) ? file : null;
    } catch {
      return file;
    }
  });
  return picked.filter(Boolean);
}

const base = process.env.TEST_BASE;
const files = base ? await affected(base) : all;

if (files.length === 0) {
  console.log(`no ${group} test reaches the changed files`);
  process.exit(0);
}
if (base) console.log(`running ${files.length} of ${all.length} ${group} test files`);
if (process.env.TEST_LIST) {
  console.log(files.join('\n'));
  process.exit(0);
}

const result = spawnSync('tsx', ['--test', ...process.argv.slice(3), ...files], {
  cwd: root,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
