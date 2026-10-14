import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpFiles } from './bump.mjs';
import { keyId, tapAdd, tapInit } from './tap.mjs';
import { tarGz } from './tar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRequire = createRequire(import.meta.url);
const HOST_SHARED = ['@nestjs/*', 'rxjs', 'rxjs/*', 'reflect-metadata'];
const ID = /^[a-z][a-z0-9-]{1,47}$/;

const out = (line = '') => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`graft: ${message}\n`);
  process.exit(1);
};

function readManifest(dir) {
  const path = join(dir, 'graft.json');
  if (!existsSync(path)) fail(`no graft.json in ${dir}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['id', 'name', 'version', 'publisher', 'engines']) {
    if (!manifest[key]) fail(`graft.json is missing "${key}"`);
  }
  if (!ID.test(manifest.id)) fail('graft.json id must be 2-48 lowercase letters, digits or dashes');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) fail('graft.json version must be semver');
  return manifest;
}

async function loadConfig(dir) {
  const path = join(dir, 'graft.config.mjs');
  if (!existsSync(path)) return {};
  const mod = await import(path);
  return mod.default ?? {};
}

function swcPlugin() {
  const swc = sdkRequire('@swc/core');
  return {
    name: 'graft-swc',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?ts$/ }, async (args) => {
        const source = readFileSync(args.path, 'utf8');
        const result = await swc.transform(source, {
          filename: args.path,
          sourceMaps: 'inline',
          jsc: {
            parser: { syntax: 'typescript', decorators: true },
            transform: { legacyDecorator: true, decoratorMetadata: true },
            target: 'es2022',
            keepClassNames: true
          },
          module: { type: 'es6' }
        });
        return { contents: result.code, loader: 'js' };
      });
    }
  };
}

async function bundleNode(entry, outfile, external) {
  const esbuild = sdkRequire('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    keepNames: true,
    sourcemap: 'inline',
    external,
    plugins: [swcPlugin()],
    logLevel: 'warning'
  });
}

async function bundleUi(dir, entry, outDir, config) {
  const { build } = await import(sdkRequire.resolve('vite'));
  const { graftUi } = await import(join(here, '..', 'src', 'vite.mjs'));
  const base = await graftUi({ entry, outDir });
  await build({
    ...base,
    root: dir,
    configFile: false,
    logLevel: 'warn',
    resolve: { ...base.resolve, alias: { ...(config.ui?.alias ?? {}) } },
    plugins: [...(base.plugins ?? []), ...(config.ui?.plugins ?? [])]
  });
}

function copyDir(from, to) {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

function listFiles(root, base = root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else if (entry.isFile()) files.push(relative(base, full).split(sep).join('/'));
  }
  return files.sort();
}

function inspect(dir, bundle) {
  const raw = execFileSync(process.execPath, [join(here, 'inspect.cjs'), bundle, dir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return JSON.parse(raw);
}

export async function build(input, options = {}) {
  const dir = resolve(input);
  const manifest = readManifest(dir);
  const config = await loadConfig(dir);
  const dist = resolve(dir, options.outDir ?? 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const external = [...HOST_SHARED, ...(config.server?.external ?? [])];
  const entries = {};

  const serverSrc = ['server/src/index.ts', 'server/src/index.js'].find((p) =>
    existsSync(join(dir, p))
  );
  if (serverSrc) {
    await bundleNode(join(dir, serverSrc), join(dist, 'server/index.cjs'), external);
    entries.server = 'server/index.cjs';
  }
  const mcpSrc = ['mcp/src/index.ts', 'mcp/src/index.js'].find((p) => existsSync(join(dir, p)));
  if (mcpSrc) {
    await bundleNode(join(dir, mcpSrc), join(dist, 'mcp/index.cjs'), external);
    entries.mcp = 'mcp/index.cjs';
  }
  const uiSrc = ['ui/src/client.ts', 'ui/src/client.js'].find((p) => existsSync(join(dir, p)));
  if (uiSrc) {
    await bundleUi(dir, join(dir, uiSrc), join(dist, 'ui'), config);
    entries.ui = 'ui/client.js';
  }
  copyDir(join(dir, 'migrations'), join(dist, 'migrations'));
  copyDir(join(dir, 'assets'), join(dist, 'assets'));
  copyDir(join(dir, 'chart'), join(dist, 'chart'));
  if (existsSync(join(dir, 'README.md'))) cpSync(join(dir, 'README.md'), join(dist, 'README.md'));

  let uses = manifest.uses ?? {};
  if (entries.server) {
    const report = inspect(dir, join(dist, 'server/index.cjs'));
    if (report.conflicts.length) fail(report.conflicts.join('\n'));
    writeFileSync(join(dist, 'routes.json'), JSON.stringify(report.routes, null, 2) + '\n');
    uses = report.uses;
    const declared = new Set(
      (manifest.public?.routes ?? []).map((r) => r.replace(/\s+/g, ' ').trim())
    );
    const undeclared = Object.entries(report.routes)
      .filter(([key, level]) => level === 'public' && !declared.has(key))
      .map(([key]) => key);
    if (undeclared.length) {
      fail(
        `public routes must be listed in graft.json public.routes:\n  ${undeclared.join('\n  ')}`
      );
    }
    const missing = Object.keys(uses)
      .map((door) => ({ door, cap: DOOR_CAPABILITY[door] }))
      .filter(({ cap }) => cap && !(manifest.capabilities ?? []).includes(cap));
    if (missing.length) {
      fail(
        `add these to graft.json capabilities: ${[...new Set(missing.map((m) => m.cap))].join(', ')}`
      );
    }
  }
  const finalManifest = { ...manifest, entries, uses };
  writeFileSync(join(dist, 'graft.json'), JSON.stringify(finalManifest, null, 2) + '\n');
  return { dist, manifest: finalManifest };
}

const DOOR_CAPABILITY = {
  users: 'users.read',
  audit: 'audit',
  secrets: 'secrets',
  flags: 'flags',
  settings: 'settings',
  events: 'events',
  db: 'db',
  http: 'http.upgrade',
  kube: 'kube.read',
  apply: 'kube.apply',
  exec: 'kube.exec',
  projects: 'projects.read',
  notifications: 'notifications',
  rateLimit: 'rateLimit',
  metrics: 'metrics',
  github: 'github',
  storage: 'storage'
};

function signingKey(options) {
  const source = options.key ?? process.env.GRAFT_SIGNING_KEY;
  if (!source) return null;
  const pem = existsSync(source)
    ? readFileSync(source, 'utf8')
    : Buffer.from(source, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

export async function pack(dir, options = {}) {
  const { dist, manifest } = await build(dir, options);
  const files = listFiles(dist).filter((f) => f !== 'MANIFEST.json' && f !== 'MANIFEST.sig');
  const hashes = Object.fromEntries(
    files.map((f) => [
      f,
      createHash('sha256')
        .update(readFileSync(join(dist, f)))
        .digest('hex')
    ])
  );
  const manifestBody = Buffer.from(JSON.stringify({ files: hashes }, null, 2) + '\n');
  writeFileSync(join(dist, 'MANIFEST.json'), manifestBody);
  const key = signingKey(options);
  if (key)
    writeFileSync(
      join(dist, 'MANIFEST.sig'),
      sign(null, manifestBody, key).toString('base64') + '\n'
    );
  const archive = tarGz(
    listFiles(dist).map((path) => ({ path, content: readFileSync(join(dist, path)) }))
  );
  const target = resolve(options.output ?? join(dir, `${manifest.id}-${manifest.version}.graft`));
  writeFileSync(target, archive);
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  return { target, digest, manifest, signed: !!key, size: statSync(target).size };
}

export function keygen(output) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  if (output) writeFileSync(output, pem, { mode: 0o600 });
  return { publicKey: raw, privateKeyPem: pem };
}

function scaffold(dir, id) {
  if (!ID.test(id)) fail('id must be 2-48 lowercase letters, digits or dashes');
  if (existsSync(join(dir, 'graft.json'))) fail(`${dir} already has a graft.json`);
  const files = {
    'graft.json': JSON.stringify(
      {
        $schema: 'https://orchard.my/schemas/graft.json',
        id,
        name: id.replace(/(^|-)(\w)/g, (_m, dash, c) => (dash ? ' ' : '') + c.toUpperCase()),
        version: '0.1.0',
        publisher: 'you',
        description: 'What this graft adds to Orchard.',
        engines: { platform: '>=2.67.0 <3', sdk: '^1.0.0' },
        capabilities: [],
        ui: { screens: [{ id: 'home', path: `/${id}`, layout: 'shell', title: id }] }
      },
      null,
      2
    ),
    'package.json': JSON.stringify(
      {
        name: `@grafts/${id}`,
        private: true,
        type: 'module',
        scripts: { build: 'graft build', pack: 'graft pack', dev: 'graft dev' },
        dependencies: { '@orchardlabs/graft-sdk': '^1.0.0', '@orchardlabs/graft-ui': '^1.0.0' },
        devDependencies: {
          '@nestjs/common': '^11.0.0',
          '@nestjs/core': '^11.0.0',
          'reflect-metadata': '^0.2.1',
          rxjs: '^7.8.1',
          svelte: '^5.0.0'
        }
      },
      null,
      2
    ),
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true
        },
        include: ['server/src', 'mcp/src', 'ui/src']
      },
      null,
      2
    ),
    'server/src/index.ts': `import { Controller, Get, Inject, Module } from '@nestjs/common';
import { Auth, Doors, GraftUserId, type ContextDoor } from '@orchardlabs/graft-sdk/server';

@Controller('hello')
class HelloController {
  constructor(@Inject(Doors.context) private readonly graft: ContextDoor) {}

  @Get()
  @Auth()
  hello(@GraftUserId() userId: string) {
    return { graft: this.graft.id, version: this.graft.version, userId };
  }
}

@Module({ controllers: [HelloController] })
export default class GraftModule {}
`,
    'ui/src/client.ts': `import { mount, unmount } from 'svelte';
import { defineGraft } from '@orchardlabs/graft-sdk/client';
import Home from './Home.svelte';

export default defineGraft({
  slots: {
    'nav.primary': [{ id: 'home', label: '${id}', href: '/${id}' }]
  },
  screens: {
    home: (target, props, host) => {
      const app = mount(Home, { target, props: { host } });
      return () => unmount(app);
    }
  }
});
`,
    'ui/src/Home.svelte': `<script lang="ts">
  import type { HostApi } from '@orchardlabs/graft-sdk/client';
  import { Button, SectionCard } from '@orchardlabs/graft-ui';

  let { host }: { host: HostApi } = $props();
  const user = host.stores.user;
  let reply = $state<string | null>(null);

  async function ping() {
    const res = await host.api<{ graft: string; version: string }>('/hello');
    reply = \`\${res.graft} \${res.version} says hi\`;
  }
</script>

<SectionCard title="Hello from a graft">
  <p>Signed in as {$user?.name}.</p>
  <Button variant="primary" onclick={ping}>Ping the server</Button>
  {#if reply}<p>{reply}</p>{/if}
</SectionCard>
`,
    'migrations/0001_init/migration.sql': "-- graft migrations run in this graft's own schema\n",
    'README.md': `# ${id}\n\nAn Orchard graft. Build it with \`graft pack\`.\n`
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function doctor(dir) {
  const manifest = readManifest(resolve(dir));
  const problems = [];
  const notes = [];
  if (!manifest.engines?.platform) problems.push('engines.platform is required');
  if (!manifest.engines?.sdk) problems.push('engines.sdk is required');
  for (const claimKind of ['apiAliases', 'uiAliases', 'wsAliases']) {
    for (const alias of manifest.claims?.[claimKind] ?? []) {
      notes.push(`${claimKind} ${alias}: core can take this path back at any time`);
    }
  }
  for (const migration of existsSync(join(dir, 'migrations'))
    ? readdirSync(join(dir, 'migrations'))
    : []) {
    const sql = readFileSync(join(dir, 'migrations', migration, 'migration.sql'), 'utf8');
    if (sql.trimStart().startsWith('-- graft:no-transaction')) {
      notes.push(
        `${migration} runs outside a transaction; a failure part way through cannot be rolled back`
      );
    }
    if (
      /\b(create|alter|drop|truncate|insert\s+into|update|delete\s+from)\s+(table\s+|index\s+|view\s+|type\s+)?(if\s+(not\s+)?exists\s+)?public\./i.test(
        sql
      )
    ) {
      const adopts = manifest.database?.adopts ?? [];
      if (adopts.length) {
        notes.push(
          `${migration} takes over core tables ${adopts.join(', ')}: they move into the graft's schema and keep a view with the old name`
        );
      } else {
        problems.push(
          `${migration} changes the public schema; grafts may only reference core tables, not change them (list tables it takes over in database.adopts)`
        );
      }
    }
  }
  return { manifest, problems, notes };
}

async function dev(input) {
  const dir = resolve(input);
  const manifest = readManifest(dir);
  const root = join(dir, '.graft-dev');
  const target = join(root, manifest.id);
  const rebuild = async () => {
    try {
      await build(dir, { outDir: target });
      out(`graft dev: rebuilt ${manifest.id} at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      process.stderr.write(`graft dev: ${err.message}\n`);
    }
  };
  await rebuild();
  out('');
  out('point your dev server at it:');
  out(`  ORCHARD_GRAFTS_DIR=${root} ORCHARD_GRAFTS_DEV=1`);
  out('UI changes are picked up on reload; restart the API server for server changes.');
  const { watch } = await import('node:fs');
  let timer = null;
  for (const sub of ['server', 'ui', 'mcp', 'migrations', 'graft.json']) {
    const path = join(dir, sub);
    if (!existsSync(path)) continue;
    watch(path, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 150);
    });
  }
}

const HELP = `graft: build and package Orchard grafts (Orchard's extensions)

  graft init <id> [dir]      scaffold a new graft
  graft build [dir]          build server, mcp and ui into dist/
  graft pack [dir] [--key <pem|base64>] [--output <file>]
                             build, hash every file, sign, and write <id>-<version>.graft
  graft dev [dir]            rebuild on change into .graft-dev/ for a local Orchard
  graft doctor [dir]         check graft.json and migrations for common mistakes
  graft keygen [file]        create an ed25519 signing key; prints the public key and its keyId
  graft tap init <dir> --name <name> --key <pem|base64> [--description <text>]
                             start a tap: a folder of grafts you host yourself
  graft tap add <dir> <file.graft>
                             check a graft is signed with the tap key and publish it in the tap
  graft bump <values.yaml...> [--platform <orchard version>] [--marketplace <url>] [--check]
                             move every graft whose version carries a # {"$graftpolicy": "^1"}
                             marker to the newest signed marketplace version the policy and
                             --platform allow, updating its digest with it

Grafts run with the same access as Orchard. Only ship what you would install yourself.`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function tap(args) {
  const sub = args.shift();
  try {
    if (sub === 'init') {
      const name = flag(args, '--name');
      const key = flag(args, '--key');
      const description = flag(args, '--description');
      if (!args[0] || !name || !key)
        fail('usage: graft tap init <dir> --name <name> --key <pem|base64> [--description <text>]');
      const result = tapInit(args[0], { name, privateKey: signingKey({ key }), description });
      out(`created the ${result.name} tap in ${relative(process.cwd(), result.dir) || '.'}`);
      out(`public key: ${result.publicKey}`);
      out(`keyId: ${result.keyId}`);
      out('');
      out('serve this folder over https, then on an Orchard host:');
      out(`  sudo orchardctl graft tap add ${result.name} <https url of this folder>`);
      return;
    }
    if (sub === 'add') {
      if (!args[0] || !args[1]) fail('usage: graft tap add <dir> <file.graft>');
      const result = tapAdd(args[0], args[1]);
      out(`added ${result.id} ${result.version} to the ${result.tap} tap`);
      out(`digest ${result.digest}`);
      out(`install with: sudo orchardctl graft add ${result.tap}/${result.id}@${result.version}`);
      return;
    }
  } catch (err) {
    fail(err.message);
  }
  fail(
    'usage: graft tap init <dir> --name <name> --key <pem|base64> | graft tap add <dir> <file.graft>'
  );
}

export async function run(argv) {
  const args = [...argv];
  const command = args.shift();
  switch (command) {
    case 'init': {
      const id = args[0];
      if (!id) fail('usage: graft init <id> [dir]');
      const dir = resolve(args[1] ?? id);
      scaffold(dir, id);
      out(`created ${relative(process.cwd(), dir) || '.'}: run graft dev inside it`);
      return;
    }
    case 'build': {
      const { dist } = await build(args[0] ?? '.');
      out(`built ${dist}`);
      return;
    }
    case 'pack': {
      const key = flag(args, '--key');
      const output = flag(args, '--output');
      const result = await pack(args[0] ?? '.', { key, output });
      out(
        `packed ${result.target} (${Math.round(result.size / 1024)} KiB, ${result.signed ? 'signed' : 'UNSIGNED'})`
      );
      out(`digest ${result.digest}`);
      out('');
      out('helm values:');
      out('  grafts:');
      out(`    - id: ${result.manifest.id}`);
      out(`      version: ${result.manifest.version}`);
      out(`      digest: ${result.digest}`);
      return;
    }
    case 'dev':
      await dev(args[0] ?? '.');
      return;
    case 'doctor': {
      const report = doctor(args[0] ?? '.');
      for (const note of report.notes) out(`note: ${note}`);
      for (const problem of report.problems) out(`problem: ${problem}`);
      out(
        report.problems.length
          ? `${report.problems.length} problems`
          : `${report.manifest.id} looks good`
      );
      if (report.problems.length) process.exit(1);
      return;
    }
    case 'keygen': {
      const { publicKey } = keygen(args[0]);
      if (args[0]) out(`private key written to ${args[0]}; keep it secret`);
      out(`public key (add to graftSettings.keys): ${publicKey}`);
      out(`keyId: ${keyId(publicKey)}`);
      return;
    }
    case 'tap':
      return tap(args);
    case 'bump': {
      const platform = flag(args, '--platform');
      const marketplace = flag(args, '--marketplace');
      const check = args.includes('--check');
      const files = args.filter((a) => a !== '--check');
      if (!files.length)
        fail(
          'usage: graft bump <values.yaml...> [--platform <version>] [--marketplace <url>] [--check]'
        );
      if (!platform) out('note: no --platform given, so engines.platform is not checked');
      const reports = await bumpFiles(files, { platform, marketplace, check });
      let changed = 0;
      for (const report of reports) {
        for (const c of report.changes) {
          changed++;
          out(`bumped ${c.id} ${c.from} -> ${c.to} (${relative(process.cwd(), report.file)})`);
        }
        for (const h of report.held) out(`held ${h.id} ${h.version}: needs Orchard ${h.needs}`);
        for (const s of report.skipped) out(`skipped ${s.id}: ${s.reason}`);
      }
      if (!changed) out('every graft is already at the newest version its policy allows');
      if (check && changed) process.exit(2);
      return;
    }
    default:
      out(HELP);
      if (command && command !== 'help' && command !== '--help') process.exit(1);
  }
}
