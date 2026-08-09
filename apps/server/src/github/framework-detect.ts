// Framework detection for the zero-config create flow.
//
// This is deliberately a mirror of Railpack's own provider rules rather than an
// independent guess, because the whole point is that the preview shown in the
// create form matches what the build actually does. Where the two could drift,
// the build wins: `railpack prepare` writes railpack-info.json and the real
// answer is reconciled onto the deployment afterwards.
//
// Rules ported from railpack (see each preset for the source file):
//   core/providers/node/{vite,astro,next,cra,angular,react_router}.go
//   core/providers/node/spa.go — isSPA / getOutputDirectory ordering
//   core/providers/staticfile/staticfile.go — root dir resolution
//
// Everything here is pure and takes an injected file reader so it can be tested
// without touching the GitHub API.

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

export interface DetectedApp {
  /** Repo-relative directory, '' for the repo root. */
  dir: string;
  framework: string;
  /** null means "let Railpack decide" — we only fill these when we add value. */
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  /** Non-null means the app is a static site served by Caddy. */
  outputDirectory: string | null;
  port: number;
  /** package.json "name", needed to scope commands inside a workspace. */
  packageName: string | null;
  /**
   * Built server entry the start command runs, relative to the app directory.
   * Kept next to startCommand rather than folded into it because a workspace
   * build runs from the repo root, where a bare `node build` would look in the
   * wrong place — scopeToWorkspace re-roots this the way it re-roots
   * outputDirectory.
   */
  serverEntry: string | null;
}

export interface WorkspaceInfo {
  isWorkspace: boolean;
  packageManager: PackageManager;
}

export interface RepoDetection {
  apps: DetectedApp[];
  workspace: WorkspaceInfo;
  /** Present when the repo commits an orchard.json. */
  repoConfig: RepoBuildConfig | null;
}

/**
 * The optional orchard.json a repository can commit. Every field is a default
 * that overrides detection but loses to a railpack.json, since Railpack merges
 * its own file last (core/core.go:145).
 */
export interface RepoBuildConfig {
  framework?: string;
  rootDirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  port?: number;
  dockerfile?: string;
}

export const REPO_CONFIG_FILE = 'orchard.json';

/** Parse orchard.json, keeping only fields of the expected type. */
export function parseRepoConfig(contents: string | null): RepoBuildConfig | null {
  if (!contents) return null;
  let raw: any;
  try {
    raw = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const config: RepoBuildConfig = {};
  for (const key of [
    'framework', 'rootDirectory', 'installCommand',
    'buildCommand', 'startCommand', 'outputDirectory', 'dockerfile',
  ] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) config[key] = value.trim();
  }
  if (Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) config.port = raw.port;

  return Object.keys(config).length > 0 ? config : null;
}

/** Apply orchard.json on top of a detected app. */
export function applyRepoConfig(app: DetectedApp, config: RepoBuildConfig | null): DetectedApp {
  if (!config) return app;
  return {
    ...app,
    framework: config.framework ?? app.framework,
    installCommand: config.installCommand ?? app.installCommand,
    buildCommand: config.buildCommand ?? app.buildCommand,
    startCommand: config.startCommand ?? app.startCommand,
    // An explicit start command retires whatever entry we detected; leaving it
    // set would describe a command that is no longer the one being run.
    serverEntry: config.startCommand ? null : app.serverEntry,
    outputDirectory: config.outputDirectory ?? app.outputDirectory,
    port: config.port ?? app.port,
  };
}

/** Files that mark a directory as a deployable app. */
const MANIFESTS = [
  'package.json',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'Cargo.toml',
  'composer.json',
  'index.html',
];

// A repo can be enormous; detection must stay a bounded number of API calls.
const MAX_CANDIDATE_DIRS = 25;
const MAX_SCAN_DEPTH = 4;
/** In flight at once. High enough to hide latency, low enough to stay polite. */
const MAX_CONCURRENT_READS = 8;

/** Promise.all with a ceiling on how many run at once. Order is preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const IGNORED_SEGMENTS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.venv', 'venv', '__pycache__',
  'testdata', 'fixtures', 'examples', 'example',
]);

export type FileReader = (path: string) => Promise<string | null>;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function isIgnored(path: string): boolean {
  return path.split('/').some((seg) => IGNORED_SEGMENTS.has(seg));
}

export function detectPackageManager(paths: Set<string>): PackageManager {
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('bun.lockb') || paths.has('bun.lock')) return 'bun';
  if (paths.has('yarn.lock')) return 'yarn';
  return 'npm';
}

/**
 * Scope a script to one package of a workspace. Used when the app lives in a
 * subdirectory but the install has to happen at the repo root so the shared
 * lockfile resolves.
 */
export function workspaceScriptCommand(
  pm: PackageManager,
  packageName: string,
  script: string,
): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm --filter ${packageName} ${script}`;
    case 'yarn':
      return `yarn workspace ${packageName} ${script}`;
    case 'bun':
      return `bun run --filter ${packageName} ${script}`;
    default:
      return `npm run ${script} --workspace ${packageName}`;
  }
}

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function allDeps(pkg: PackageJson): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function scriptOf(pkg: PackageJson, name: string): string {
  return pkg.scripts?.[name] ?? '';
}

/** `outDir: 'somewhere'` in a vite/astro config, matching railpack's regex. */
function outDirFromConfig(contents: string | null): string | null {
  if (!contents) return null;
  const m = /outDir:\s*['"](.+?)['"]/.exec(contents);
  return m ? m[1].replace(/^\.\//, '').replace(/\/+$/, '') : null;
}

/**
 * `out: 'somewhere'` in a SvelteKit adapter-node call. `\bout:` cannot match
 * `output:`, so the sibling option in the same object is not a false positive.
 */
function adapterOutFromConfig(contents: string | null): string | null {
  if (!contents) return null;
  const m = /\bout:\s*['"](.+?)['"]/.exec(contents);
  return m ? m[1].replace(/^\.\//, '').replace(/\/+$/, '') : null;
}

/**
 * Whether Railpack will find a start command on its own.
 *
 * Mirrors node.go:188 exactly: a `start` script, a `main` field, or an
 * index.js/index.ts in the *app root* (railpack globs `{index.js,index.ts}`
 * with no `**`, so it never recurses). Everything past that point in its
 * checklist is framework-specific and handled by the presets below.
 *
 * This matters more than it looks. When Railpack finds nothing it does not
 * fail — validate.go:71 downgrades to a warning unless --error-missing-start
 * is set, and buildkit/convert.go:65 then bakes `CMD ["/bin/bash"]` into the
 * image. The build goes green and ships a container that exits 0 with no
 * output. So a preset that knows the answer has to say so here.
 */
function railpackFindsStartCommand(pkg: PackageJson, dir: string, paths: Set<string>): boolean {
  if (scriptOf(pkg, 'start')) return true;
  if (typeof pkg.main === 'string' && pkg.main.trim()) return true;
  return paths.has(join(dir, 'index.js')) || paths.has(join(dir, 'index.ts'));
}

/**
 * Classify one directory. `read` resolves paths relative to the repo root, so a
 * preset that needs a config file asks for it lazily — most apps never trigger
 * more than the package.json fetch.
 */
async function classify(
  dir: string,
  paths: Set<string>,
  read: FileReader,
): Promise<DetectedApp | null> {
  const has = (name: string) => paths.has(join(dir, name));

  // The tree already tells us which files exist, so never spend a round trip
  // discovering that a config variant is absent. Detection latency is almost
  // entirely GitHub round trips.
  const firstExisting = async (...names: string[]): Promise<string | null> => {
    const name = names.find(has);
    return name ? read(join(dir, name)) : null;
  };

  const base: DetectedApp = {
    dir,
    framework: 'unknown',
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    port: 3000,
    packageName: null,
    serverEntry: null,
  };

  if (has('package.json')) {
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse((await read(join(dir, 'package.json'))) ?? '{}');
    } catch {
      // Unparseable package.json: still a node app, just no preset detail.
    }
    const deps = allDeps(pkg);
    const buildScript = scriptOf(pkg, 'build').toLowerCase();
    const app: DetectedApp = { ...base, framework: 'node', packageName: pkg.name ?? null };
    // Only fill a start command in when Railpack would otherwise come up empty.
    const needsStart = !railpackFindsStartCommand(pkg, dir, paths);

    // Order mirrors spa.go:getOutputDirectory — the first match wins.
    if (deps['@sveltejs/kit']) {
      // SvelteKit is not static by default (vite.go:29 excludes it explicitly);
      // adapter-static is the exception, and only when it is the adapter the
      // config actually selects.
      app.framework = 'sveltekit';
      const svelteConfig = await firstExisting(
        'svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts',
        'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
      );
      if (svelteConfig && /@sveltejs\/adapter-static/.test(svelteConfig)) {
        app.outputDirectory = 'build';
      } else if (needsStart && !deps['@sveltejs/adapter-auto']) {
        // adapter-node emits a Node server at `out` (default `build`), and
        // `node build` is what SvelteKit documents. Railpack knows this command
        // but gates it behind adapter-auto (svelte.go:18), so naming
        // adapter-node explicitly — the thing the docs tell you to do — is
        // exactly the case it drops on the floor.
        app.serverEntry = adapterOutFromConfig(svelteConfig) ?? 'build';
        app.startCommand = `node ${app.serverEntry}`;
      }
    } else if (deps['react-router'] && buildScript.includes('react-router build')) {
      app.framework = 'react-router';
      app.outputDirectory = 'build/client';
    } else if (deps['@remix-run/node']) {
      app.framework = 'remix';
    } else if (deps.next) {
      app.framework = 'nextjs';
      const cfg = await firstExisting('next.config.js', 'next.config.mjs', 'next.config.ts');
      if (cfg && /output:\s*['"]export['"]/.test(cfg)) app.outputDirectory = 'out';
    } else if (deps.astro) {
      app.framework = 'astro';
      app.port = 4321;
      const cfg = await firstExisting('astro.config.mjs', 'astro.config.ts', 'astro.config.js');
      const hasAdapter = ['@astrojs/node', '@astrojs/vercel', '@astrojs/cloudflare', '@astrojs/netlify']
        .some((d) => deps[d]);
      const serverOutput = cfg ? /output:\s*['"]server['"]/.test(cfg) : false;
      if (!hasAdapter && !serverOutput) {
        app.outputDirectory = outDirFromConfig(cfg) ?? 'dist';
      } else if (needsStart && deps['@astrojs/node'] && !/mode:\s*['"]middleware['"]/.test(cfg ?? '')) {
        // Same gap as SvelteKit: Railpack has no Astro entry in its
        // start-command checklist at all. Standalone is the only mode that
        // produces a server we can start — middleware mode expects the user to
        // bring their own entrypoint, and guessing one would be worse than the
        // build failing with Railpack's own explanation.
        app.serverEntry = 'dist/server/entry.mjs';
        app.startCommand = `node ${app.serverEntry}`;
      }
    } else if (deps.nuxt) {
      app.framework = 'nuxt';
    } else if (deps['react-scripts'] && buildScript.includes('react-scripts build')) {
      app.framework = 'cra';
      app.outputDirectory = 'build';
      app.port = 80;
    } else if (deps['@angular/core'] && has('angular.json') && buildScript.includes('ng build')) {
      // railpack reads the output path out of angular.json; that shape varies
      // by Angular version, so leave it to the build to reconcile rather than
      // guess a path that would silently serve nothing.
      app.framework = 'angular';
      app.port = 80;
    } else if (deps['@nestjs/core']) {
      app.framework = 'nestjs';
    } else if (deps.fastify) {
      app.framework = 'fastify';
    } else if (deps.express) {
      app.framework = 'express';
    } else if (deps.vite && (has('vite.config.js') || has('vite.config.ts')) && pkg.scripts?.build) {
      app.framework = 'vite';
      const cfg = await firstExisting('vite.config.ts', 'vite.config.js');
      app.outputDirectory = outDirFromConfig(cfg) ?? 'dist';
      app.port = 80;
    }

    // A static build is served by Caddy, which listens on $PORT (default 80).
    if (app.outputDirectory && app.port === 3000) app.port = 80;
    return app;
  }

  if (has('go.mod')) return { ...base, framework: 'go', port: 8080 };
  if (has('requirements.txt') || has('pyproject.toml')) return { ...base, framework: 'python', port: 8000 };
  if (has('Gemfile')) return { ...base, framework: 'ruby' };
  if (has('Cargo.toml')) return { ...base, framework: 'rust', port: 8080 };
  if (has('composer.json')) return { ...base, framework: 'php', port: 8080 };
  if (has('index.html')) {
    // staticfile.go: prefer a public/ dir, else serve the directory itself.
    return {
      ...base,
      framework: 'static',
      outputDirectory: paths.has(join(dir, 'public/index.html')) ? 'public' : '.',
      port: 80,
    };
  }

  return null;
}

/**
 * Find every deployable app in a repo, plus whether it is a JS workspace.
 *
 * `paths` is the flat list of blob paths from one recursive Git Trees call.
 */
export async function detectApps(paths: string[], read: FileReader): Promise<RepoDetection> {
  const pathSet = new Set(paths);
  const packageManager = detectPackageManager(pathSet);

  // Everything below is a GitHub round trip, so the three independent groups of
  // reads (workspace check, orchard.json, per-app classification) are started
  // together rather than one after another.
  const workspacePromise = (async () => {
    if (pathSet.has('pnpm-workspace.yaml')) return true;
    if (!pathSet.has('package.json')) return false;
    try {
      const root: PackageJson = JSON.parse((await read('package.json')) ?? '{}');
      const ws = root.workspaces;
      return Array.isArray(ws) ? ws.length > 0 : Boolean(ws?.packages?.length);
    } catch {
      // Root package.json unreadable: assume not a workspace.
      return false;
    }
  })();

  // orchard.json is read from the root, or from the directory it names, so a
  // monorepo can keep one file per app next to the app.
  const repoConfigPromise = pathSet.has(REPO_CONFIG_FILE)
    ? read(REPO_CONFIG_FILE).then(parseRepoConfig)
    : Promise.resolve(null);

  const candidateDirs: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (isIgnored(p)) continue;
    if (!MANIFESTS.includes(baseOf(p))) continue;
    const dir = dirOf(p);
    if (seen.has(dir)) continue;
    if (dir && dir.split('/').length > MAX_SCAN_DEPTH) continue;
    seen.add(dir);
    candidateDirs.push(dir);
  }

  // Shallowest first: the repo root and top-level apps matter most, and this is
  // also the order the picker shows them in.
  candidateDirs.sort((a, b) => {
    const da = a === '' ? 0 : a.split('/').length;
    const db = b === '' ? 0 : b.split('/').length;
    return da - db || a.localeCompare(b);
  });

  // One directory's classification never depends on another's, so they run
  // concurrently instead of one round trip after another. The cap keeps a
  // 25-app monorepo from turning into a burst GitHub reads as abuse.
  const classified = await mapWithConcurrency(
    candidateDirs.slice(0, MAX_CANDIDATE_DIRS),
    MAX_CONCURRENT_READS,
    (dir) => classify(dir, pathSet, read),
  );
  const apps = classified.filter((app): app is DetectedApp => app !== null);

  const workspace: WorkspaceInfo = { isWorkspace: await workspacePromise, packageManager };
  const scoped = apps.map((app) => scopeToWorkspace(app, workspace));

  const repoConfig = await repoConfigPromise;

  // Only the app the config points at is affected; the others stay as detected.
  const target = repoConfig?.rootDirectory ?? (repoConfig ? '' : null);
  return {
    apps: scoped.map((app) => (target !== null && app.dir === target ? applyRepoConfig(app, repoConfig) : app)),
    workspace,
    repoConfig,
  };
}

/**
 * Rewrite a nested app's commands so it can be built from the repo root.
 *
 * Inside a JS workspace we cannot simply build in the subdirectory: the
 * lockfile and shared packages live at the root, so the install has to happen
 * there. Railpack also only inspects the workspace *root* package when it
 * decides whether something is an SPA (core/providers/node/spa.go:41), so a
 * Vite app at apps/web is never detected as static on its own — spelling out
 * the output directory is what makes monorepo static sites work at all.
 *
 * These land in the deployment's build settings as ordinary editable values,
 * so the user can see exactly what will run instead of guessing at magic.
 */
function scopeToWorkspace(app: DetectedApp, workspace: WorkspaceInfo): DetectedApp {
  if (!workspace.isWorkspace || !app.dir || !app.packageName) return app;

  const pm = workspace.packageManager;

  // A detected server entry is a path, so it moves with the app the same way
  // the output directory does. `pnpm --filter <pkg> start` is only the right
  // answer when the package actually has a start script to run.
  const startCommand = (() => {
    if (app.outputDirectory) return app.startCommand;
    if (app.serverEntry) return `node ${app.dir}/${app.serverEntry}`;
    return app.startCommand ?? workspaceScriptCommand(pm, app.packageName, 'start');
  })();

  return {
    ...app,
    // Install stays unscoped: Railpack already installs a workspace correctly.
    buildCommand: app.buildCommand ?? workspaceScriptCommand(pm, app.packageName, 'build'),
    startCommand,
    outputDirectory: app.outputDirectory ? `${app.dir}/${app.outputDirectory}` : null,
  };
}

/**
 * Choose the app to preselect in the create form: prefer a real framework at
 * the repo root, else the shallowest detected app.
 */
export function primaryApp(apps: DetectedApp[]): DetectedApp | null {
  if (apps.length === 0) return null;
  const root = apps.find((a) => a.dir === '');
  if (root && root.framework !== 'unknown') return root;
  return apps[0];
}
