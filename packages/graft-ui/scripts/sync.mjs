import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const pkg = resolve(import.meta.dirname, '..');
const lib = resolve(pkg, '../../apps/frontend/src/lib');
const out = join(pkg, 'src');
const EXTRA = ['components/ConfirmModal.svelte'];
const STATEMENT =
  /(?:import|export)\s+(type\s+)?[^'"]*?from\s*(['"])([^'"]+)\2|import\s*\(\s*(['"])([^'"]+)\4\s*\)|import\s+(['"])([^'"]+)\6/g;
const SHIMS = {
  '$app/environment':
    "export const browser = typeof window !== 'undefined';\nexport const dev = false;\nexport const building = false;\nexport const version = 'graft';\n"
};

function resolveLib(spec) {
  const rel = spec.slice('$lib/'.length);
  for (const candidate of [rel, `${rel}.ts`, `${rel}.js`, `${rel}/index.ts`, `${rel}.svelte.ts`]) {
    if (existsSync(join(lib, candidate)) && !candidate.endsWith('/')) {
      const full = join(lib, candidate);
      try {
        readFileSync(full);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`cannot resolve ${spec}`);
}

const queue = ['components/ui/index.ts', ...EXTRA];
const seen = new Set();
const shimsUsed = new Set();
rmSync(out, { recursive: true, force: true });
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const source = readFileSync(join(lib, rel), 'utf8');
  const rewritten = source.replace(
    STATEMENT,
    (statement, typeOnly, _q1, spec1, _q2, spec2, _q3, spec3) => {
      const spec = spec1 ?? spec2 ?? spec3;
      const runtime = !typeOnly;
      let target = null;
      if (spec.startsWith('$lib/')) target = resolveLib(spec);
      else if (spec.startsWith('.')) {
        const joined = join(dirname(rel), spec);
        target =
          [joined, `${joined}.ts`, `${joined}.js`].find(
            (t) => existsSync(join(lib, t)) && !t.endsWith('/')
          ) ?? null;
        if (target && runtime) queue.push(target);
        return statement;
      } else if (spec in SHIMS) {
        shimsUsed.add(spec);
        const shimPath = relative(
          dirname(join(out, rel)),
          join(out, 'shims', spec.replace(/[$/]/g, '_'))
        )
          .split('\\')
          .join('/');
        return statement.replace(spec, shimPath.startsWith('.') ? shimPath : `./${shimPath}`);
      } else {
        if (spec.startsWith('$'))
          throw new Error(`${rel} imports ${spec}, which a graft build cannot resolve`);
        return statement;
      }
      if (runtime) queue.push(target);
      let path = relative(dirname(join(out, rel)), join(out, target))
        .split('\\')
        .join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      return statement.replace(spec, path.replace(/\.ts$/, ''));
    }
  );
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), rewritten);
}
writeFileSync(
  join(out, 'index.ts'),
  "export * from './components/ui/index';\nexport { default as ConfirmModal } from './components/ConfirmModal.svelte';\n"
);
cpSync(resolve(lib, '../tokens.css'), join(out, 'tokens.css'));
for (const spec of shimsUsed) {
  mkdirSync(join(out, 'shims'), { recursive: true });
  writeFileSync(join(out, 'shims', `${spec.replace(/[$/]/g, '_')}.ts`), SHIMS[spec]);
}
process.stdout.write(`graft-ui: synced ${seen.size} files from apps/frontend/src/lib\n`);
