import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectApps,
  primaryApp,
  detectPackageManager,
  workspaceScriptCommand,
  parseRepoConfig,
} from '../src/github/framework-detect';

/** Build a reader over an in-memory repo. */
function repo(files: Record<string, string>) {
  const paths = Object.keys(files);
  const read = async (p: string) => (p in files ? files[p] : null);
  return { paths, read };
}

const pkg = (o: unknown) => JSON.stringify(o);

test('plain Vite SPA is detected as static with dist output', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ name: 'site', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default { }',
    'index.html': '<html></html>',
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'vite');
  assert.equal(app.outputDirectory, 'dist');
  assert.equal(app.port, 80);
});

test('vite outDir override in the config is respected', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default { build: { outDir: "public/app/" } }',
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.outputDirectory, 'public/app');
});

test('SvelteKit is a server app, not a static site', async () => {
  // vite.go:29 excludes SvelteKit from SPA detection — it would otherwise match
  // on the vite dependency and get served as an empty directory.
  const { paths, read } = repo({
    'package.json': pkg({
      scripts: { build: 'vite build' },
      devDependencies: { vite: '^5', '@sveltejs/kit': '^2' },
    }),
    'vite.config.ts': 'export default { }',
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'sveltekit');
  assert.equal(app.outputDirectory, null, 'SvelteKit must not be treated as static');
});

test('SvelteKit with adapter-static is static', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      scripts: { build: 'vite build' },
      devDependencies: { '@sveltejs/kit': '^2', '@sveltejs/adapter-static': '^3' },
    }),
    'svelte.config.js': "import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };",
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.outputDirectory, 'build');
});

test('SvelteKit shipping adapter-static but configuring adapter-node is a server app', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      scripts: { build: 'vite build' },
      devDependencies: {
        '@sveltejs/kit': '^2',
        '@sveltejs/adapter-auto': '^7',
        '@sveltejs/adapter-node': '^5',
        '@sveltejs/adapter-static': '^3',
      },
    }),
    'vite.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { plugins: [sveltekit({ adapter: adapter() })] };",
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'sveltekit');
  assert.equal(app.outputDirectory, null, 'an adapter-node build must not be served as static');
});

// Railpack only emits `node build` for SvelteKit when the repo depends on
// @sveltejs/adapter-auto (svelte.go:18). Naming adapter-node directly — what
// the SvelteKit docs tell you to do — leaves its plan with no start command at
// all, and buildkit then bakes CMD ["/bin/bash"] into the image
// (convert.go:65): the build goes green and the container exits 0 on boot.
test('SvelteKit on adapter-node gets the start command railpack will not emit', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      scripts: { build: 'vite build' },
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'svelte.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };",
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.startCommand, 'node build');
  assert.equal(app.outputDirectory, null);
});

test('a SvelteKit adapter-node out directory is respected', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'svelte.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter({ out: './server/' }) } };",
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.startCommand, 'node server');
});

test('`output:` in a SvelteKit config is not mistaken for the adapter out dir', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'svelte.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { output: 'nope', adapter: adapter() } };",
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.startCommand, 'node build');
});

test('SvelteKit on adapter-auto is left to railpack', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      devDependencies: { '@sveltejs/kit': '^2', '@sveltejs/adapter-auto': '^7' },
    }),
    'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };",
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(
    primaryApp(apps)!.startCommand,
    null,
    'railpack emits `node build` itself, and also sets GCP_BUILDPACKS so the build produces one',
  );
});

// The three checks railpack runs before any framework preset (node.go:189-194).
test('a start command railpack can already find is left alone', async () => {
  for (const [label, files] of [
    ['start script', { 'package.json': pkg({ scripts: { start: 'node build' }, dependencies: { '@sveltejs/adapter-node': '^5' }, devDependencies: { '@sveltejs/kit': '^2' } }) }],
    ['main field', { 'package.json': pkg({ main: 'server.js', dependencies: { '@sveltejs/adapter-node': '^5' }, devDependencies: { '@sveltejs/kit': '^2' } }) }],
    ['root index.js', {
      'package.json': pkg({ dependencies: { '@sveltejs/adapter-node': '^5' }, devDependencies: { '@sveltejs/kit': '^2' } }),
      'index.js': '',
    }],
  ] as [string, Record<string, string>][]) {
    const { paths, read } = repo(files);
    const { apps } = await detectApps(paths, read);
    assert.equal(primaryApp(apps)!.startCommand, null, label);
  }
});

test('a nested index.js does not count — railpack only globs the app root', async () => {
  // node.go:193 globs `{index.js,index.ts}` with no `**`, so src/index.js is
  // invisible to it and the app would ship unstartable.
  const { paths, read } = repo({
    'package.json': pkg({
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'src/index.js': '',
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.startCommand, 'node build');
});

test('a workspace SvelteKit app starts from the repo root', async () => {
  // The build runs at the repo root, so a bare `node build` would look in the
  // wrong directory — and `pnpm --filter start`, the usual workspace fallback,
  // would run a script the package does not have.
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
    'pnpm-lock.yaml': '',
    'apps/web/package.json': pkg({
      name: '@acme/web',
      scripts: { build: 'vite build' },
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'apps/web/svelte.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };",
  });
  const { apps } = await detectApps(paths, read);
  const web = apps.find((a) => a.dir === 'apps/web')!;
  assert.equal(web.startCommand, 'node apps/web/build');
  assert.equal(web.buildCommand, 'pnpm --filter @acme/web build');
});

test('Astro on the node adapter gets a start command, middleware mode does not', async () => {
  const standalone = repo({
    'package.json': pkg({ dependencies: { astro: '^5', '@astrojs/node': '^9' } }),
    'astro.config.mjs': "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node({ mode: 'standalone' }) };",
  });
  const { apps: standaloneApps } = await detectApps(standalone.paths, standalone.read);
  assert.equal(primaryApp(standaloneApps)!.startCommand, 'node dist/server/entry.mjs');
  assert.equal(primaryApp(standaloneApps)!.outputDirectory, null);

  // Middleware mode emits a handler, not a server: there is no entrypoint to
  // guess, and a wrong guess is worse than the build failing with railpack's
  // own explanation.
  const middleware = repo({
    'package.json': pkg({ dependencies: { astro: '^5', '@astrojs/node': '^9' } }),
    'astro.config.mjs': "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node({ mode: 'middleware' }) };",
  });
  const { apps: middlewareApps } = await detectApps(middleware.paths, middleware.read);
  assert.equal(primaryApp(middlewareApps)!.startCommand, null);
});

test('a static Astro site is still static', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ dependencies: { astro: '^5' } }),
    'astro.config.mjs': 'export default {};',
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.outputDirectory, 'dist');
  assert.equal(app.startCommand, null, 'Caddy supplies the start command for a static site');
});

test('an explicit start command in orchard.json retires the detected entry', async () => {
  const { paths, read } = repo({
    'package.json': pkg({
      dependencies: { '@sveltejs/adapter-node': '^5' },
      devDependencies: { '@sveltejs/kit': '^2' },
    }),
    'orchard.json': JSON.stringify({ startCommand: 'node ./custom.js' }),
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.startCommand, 'node ./custom.js');
  assert.equal(app.serverEntry, null, 'a stale entry would describe a command nobody runs');
});

test('Next.js is a server app unless output: export is configured', async () => {
  const ssr = repo({
    'package.json': pkg({ dependencies: { next: '^15' } }),
    'next.config.js': 'module.exports = {}',
  });
  const { apps: ssrApps } = await detectApps(ssr.paths, ssr.read);
  assert.equal(primaryApp(ssrApps)!.outputDirectory, null);

  const exported = repo({
    'package.json': pkg({ dependencies: { next: '^15' } }),
    'next.config.js': "module.exports = { output: 'export' }",
  });
  const { apps: expApps } = await detectApps(exported.paths, exported.read);
  const app = primaryApp(expApps)!;
  assert.equal(app.framework, 'nextjs');
  assert.equal(app.outputDirectory, 'out');
});

test('Astro is static by default but server when an adapter is present', async () => {
  const stat = repo({
    'package.json': pkg({ dependencies: { astro: '^5' } }),
    'astro.config.mjs': 'export default {}',
  });
  const { apps: a1 } = await detectApps(stat.paths, stat.read);
  assert.equal(primaryApp(a1)!.outputDirectory, 'dist');

  const ssr = repo({
    'package.json': pkg({ dependencies: { astro: '^5', '@astrojs/node': '^9' } }),
    'astro.config.mjs': "export default { output: 'server' }",
  });
  const { apps: a2 } = await detectApps(ssr.paths, ssr.read);
  const app = primaryApp(a2)!;
  assert.equal(app.framework, 'astro');
  assert.equal(app.outputDirectory, null);
});

test('Create React App maps to build/', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ scripts: { build: 'react-scripts build' }, dependencies: { 'react-scripts': '^5' } }),
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'cra');
  assert.equal(app.outputDirectory, 'build');
});

test('Angular is detected but the output path is left for the build to reconcile', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ scripts: { build: 'ng build' }, dependencies: { '@angular/core': '^19' } }),
    'angular.json': '{}',
  });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'angular');
  assert.equal(app.outputDirectory, null, 'guessing an Angular path would silently serve nothing');
});

test('a bare index.html repo is a static site', async () => {
  const { paths, read } = repo({ 'index.html': '<html></html>', 'style.css': '' });
  const { apps } = await detectApps(paths, read);
  const app = primaryApp(apps)!;
  assert.equal(app.framework, 'static');
  assert.equal(app.outputDirectory, '.');
  assert.equal(app.port, 80);
});

test('non-node languages get their conventional ports', async () => {
  const cases: [string, string, number][] = [
    ['go.mod', 'go', 8080],
    ['requirements.txt', 'python', 8000],
    ['Cargo.toml', 'rust', 8080],
    ['composer.json', 'php', 8080],
    ['Gemfile', 'ruby', 3000],
  ];
  for (const [file, framework, port] of cases) {
    const { paths, read } = repo({ [file]: '' });
    const { apps } = await detectApps(paths, read);
    const app = primaryApp(apps)!;
    assert.equal(app.framework, framework, file);
    assert.equal(app.port, port, file);
  }
});

test('a pnpm monorepo yields one app per package and is flagged as a workspace', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'pnpm-lock.yaml': '',
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'apps/web/vite.config.ts': 'export default {}',
    'apps/api/package.json': pkg({ name: '@acme/api', dependencies: { express: '^4' } }),
  });
  const { apps, workspace } = await detectApps(paths, read);

  assert.equal(workspace.isWorkspace, true);
  assert.equal(workspace.packageManager, 'pnpm');

  const web = apps.find((a) => a.dir === 'apps/web')!;
  assert.equal(web.framework, 'vite');
  assert.equal(web.outputDirectory, 'apps/web/dist', 'repo-relative inside a workspace');
  assert.equal(web.packageName, '@acme/web');

  const api = apps.find((a) => a.dir === 'apps/api')!;
  assert.equal(api.framework, 'express');
});

test('npm workspaces are detected from the root package.json alone', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ workspaces: ['packages/*'] }),
    'package-lock.json': '',
    'packages/app/package.json': pkg({ name: 'app' }),
  });
  const { workspace } = await detectApps(paths, read);
  assert.equal(workspace.isWorkspace, true);
  assert.equal(workspace.packageManager, 'npm');
});

test('a repo with sibling dirs and no workspace config is not a workspace', async () => {
  const { paths, read } = repo({
    'frontend/package.json': pkg({ name: 'fe', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'frontend/vite.config.ts': 'export default {}',
    'backend/go.mod': 'module backend',
  });
  const { apps, workspace } = await detectApps(paths, read);
  assert.equal(workspace.isWorkspace, false);
  assert.equal(apps.length, 2);
  assert.equal(apps.find((a) => a.dir === 'backend')!.framework, 'go');
});

test('build artefacts and vendored deps never become candidate apps', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root' }),
    'node_modules/left-pad/package.json': pkg({ name: 'left-pad' }),
    'dist/package.json': pkg({ name: 'dist' }),
    'vendor/thing/go.mod': 'module thing',
    'examples/demo/package.json': pkg({ name: 'demo' }),
  });
  const { apps } = await detectApps(paths, read);
  assert.deepEqual(apps.map((a) => a.dir), ['']);
});

test('primaryApp prefers a recognised root app over a nested one', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default {}',
    'tools/helper/package.json': pkg({ name: 'helper' }),
  });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.dir, '');
});

test('package manager detection follows the lockfile', () => {
  assert.equal(detectPackageManager(new Set(['pnpm-lock.yaml'])), 'pnpm');
  assert.equal(detectPackageManager(new Set(['yarn.lock'])), 'yarn');
  assert.equal(detectPackageManager(new Set(['bun.lockb'])), 'bun');
  assert.equal(detectPackageManager(new Set(['package-lock.json'])), 'npm');
  assert.equal(detectPackageManager(new Set()), 'npm');
});

test('workspace commands use each package manager native filter syntax', () => {
  assert.equal(workspaceScriptCommand('pnpm', '@acme/web', 'build'), 'pnpm --filter @acme/web build');
  assert.equal(workspaceScriptCommand('yarn', '@acme/web', 'build'), 'yarn workspace @acme/web build');
  assert.equal(workspaceScriptCommand('npm', '@acme/web', 'build'), 'npm run build --workspace @acme/web');
  assert.equal(workspaceScriptCommand('bun', '@acme/web', 'start'), 'bun run --filter @acme/web start');
});

test('an unparseable package.json still yields a node app', async () => {
  const { paths, read } = repo({ 'package.json': '{ not json' });
  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.framework, 'node');
});

test('a workspace app is scoped to its package so it can build from the repo root', async () => {
  // Inside a workspace the lockfile lives at the root, so the build cannot just
  // cd into apps/web. The commands are rewritten instead, and the output dir is
  // made repo-relative because railpack's SPA detection only inspects the
  // workspace root package (spa.go:41).
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'pnpm-lock.yaml': '',
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'apps/web/vite.config.ts': 'export default {}',
  });
  const { apps } = await detectApps(paths, read);
  const web = apps.find((a) => a.dir === 'apps/web')!;

  assert.equal(web.buildCommand, 'pnpm --filter @acme/web build');
  assert.equal(web.outputDirectory, 'apps/web/dist');
  assert.equal(web.installCommand, null, 'railpack already installs a workspace correctly');
  assert.equal(web.startCommand, null, 'a static app is served by Caddy, not started');
});

test('a workspace server app gets a scoped start command', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
    'pnpm-lock.yaml': '',
    'apps/api/package.json': pkg({ name: '@acme/api', dependencies: { express: '^4' } }),
  });
  const { apps } = await detectApps(paths, read);
  const api = apps.find((a) => a.dir === 'apps/api')!;

  assert.equal(api.buildCommand, 'pnpm --filter @acme/api build');
  assert.equal(api.startCommand, 'pnpm --filter @acme/api start');
  assert.equal(api.outputDirectory, null);
});

test('the workspace root app itself is never scoped', async () => {
  const { paths, read } = repo({
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'], scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default {}',
    'pnpm-lock.yaml': '',
  });
  const { apps } = await detectApps(paths, read);
  const root = apps.find((a) => a.dir === '')!;
  assert.equal(root.buildCommand, null);
  assert.equal(root.outputDirectory, 'dist');
});

test('a subdirectory app outside a workspace keeps plain commands', async () => {
  // This one builds by pointing railpack at the subdirectory instead, so its
  // output dir stays relative to that directory.
  const { paths, read } = repo({
    'frontend/package.json': pkg({ name: 'fe', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'frontend/vite.config.ts': 'export default {}',
  });
  const { apps } = await detectApps(paths, read);
  const fe = apps.find((a) => a.dir === 'frontend')!;
  assert.equal(fe.buildCommand, null);
  assert.equal(fe.outputDirectory, 'dist');
});

test('orchard.json overrides detection for the app it names', async () => {
  const { paths, read } = repo({
    'orchard.json': JSON.stringify({ rootDirectory: 'apps/web', buildCommand: 'make bundle', outputDirectory: 'public' }),
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
    'pnpm-lock.yaml': '',
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'apps/web/vite.config.ts': 'export default {}',
    'apps/api/package.json': pkg({ name: '@acme/api', dependencies: { express: '^4' } }),
  });
  const { apps, repoConfig } = await detectApps(paths, read);

  assert.equal(repoConfig?.rootDirectory, 'apps/web');
  const web = apps.find((a) => a.dir === 'apps/web')!;
  assert.equal(web.buildCommand, 'make bundle');
  assert.equal(web.outputDirectory, 'public');

  const api = apps.find((a) => a.dir === 'apps/api')!;
  assert.equal(api.buildCommand, 'pnpm --filter @acme/api build', 'other apps are untouched');
});

test('orchard.json without a rootDirectory applies to the repo root app', async () => {
  const { paths, read } = repo({
    'orchard.json': JSON.stringify({ outputDirectory: 'site', port: 8081 }),
    'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default {}',
  });
  const { apps } = await detectApps(paths, read);
  const root = apps.find((a) => a.dir === '')!;
  assert.equal(root.outputDirectory, 'site');
  assert.equal(root.port, 8081);
});

test('a malformed or hostile orchard.json is ignored rather than trusted', async () => {
  assert.equal(parseRepoConfig('{ not json'), null);
  assert.equal(parseRepoConfig(''), null);
  assert.equal(parseRepoConfig('null'), null);
  assert.equal(parseRepoConfig('[]'), null);
  assert.equal(parseRepoConfig('{}'), null);
  assert.equal(parseRepoConfig(JSON.stringify({ buildCommand: 123, port: 'x' })), null);
  assert.deepEqual(parseRepoConfig(JSON.stringify({ port: 70000 })), null);
  assert.deepEqual(parseRepoConfig(JSON.stringify({ buildCommand: '  pnpm build  ' })), { buildCommand: 'pnpm build' });
});

test('detection never fetches a file the tree says is absent', async () => {
  // Every read is a GitHub round trip, so asking for next.config.js on a repo
  // that has next.config.ts is latency spent to learn nothing.
  const requested: string[] = [];
  const files: Record<string, string> = {
    'package.json': pkg({ scripts: { build: 'next build' }, dependencies: { next: '^14' } }),
    'next.config.ts': 'export default { output: "export" }',
  };
  const paths = Object.keys(files);
  const read = async (p: string) => {
    requested.push(p);
    return p in files ? files[p] : null;
  };

  const { apps } = await detectApps(paths, read);
  assert.equal(primaryApp(apps)!.outputDirectory, 'out');
  assert.deepEqual(
    requested.filter((p) => !paths.includes(p)),
    [],
    'a path outside the tree was fetched',
  );
});

test('apps in a monorepo are classified concurrently', async () => {
  const files: Record<string, string> = {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*',
    'pnpm-lock.yaml': '',
    'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
  };
  for (let i = 0; i < 6; i += 1) {
    files[`apps/app${i}/package.json`] = pkg({ name: `@acme/app${i}`, scripts: { build: 'tsc' } });
  }

  let inFlight = 0;
  let peak = 0;
  const read = async (p: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return p in files ? files[p] : null;
  };

  const { apps } = await detectApps(Object.keys(files), read);
  assert.equal(apps.length, 7);
  assert.ok(peak > 1, `reads ran one at a time (peak ${peak})`);
});
