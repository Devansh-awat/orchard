// Translation layer between Orchard's stored build settings and the RAILPACK_*
// environment variables Railpack reads when it generates a build plan.
//
// Railpack merges its config as Merge(cliOptions, env, railpack.json) with the
// later source winning, so everything emitted here is still overridable by a
// railpack.json committed to the repo. That ordering is deliberate: the UI is
// the easy path, the repo file is the escape hatch.
//
// Variable names verified against railpack's source, not its docs:
//   core/core.go:209,217,225 — INSTALL_CMD / BUILD_CMD / START_CMD
//   core/providers/node/spa.go:16 — SPA_OUTPUT_DIR
// All are read through Environment.GetConfigVariable, which prefixes RAILPACK_
// (core/app/environment.go:61).

/**
 * Prefix the railpack-prepare init container echoes its single-line
 * railpack-info.json behind, so the server can recover what Railpack actually
 * detected from an otherwise human-oriented build log.
 */
export const RAILPACK_INFO_MARKER = '::orchard-railpack-info::';

/** The subset of railpack-info.json worth surfacing to users. */
export interface RailpackDetection {
  /** Railpack's own runtime label: vite, next, astro, static, node, ... */
  framework: string | null;
  providers: string[];
  isStatic: boolean;
  packageManager: string | null;
  railpackVersion: string | null;
}

/**
 * Recover the detection result from a build log.
 *
 * `railpack prepare --info-out` writes core.BuildResult with the plan stripped
 * (railpack cli/prepare.go:80), so the fields of interest are detectedProviders
 * and the provider metadata (node.go:538-540).
 */
export function parseRailpackInfo(logs: string | null | undefined): RailpackDetection | null {
  if (!logs) return null;

  const idx = logs.lastIndexOf(RAILPACK_INFO_MARKER);
  if (idx === -1) return null;

  const start = idx + RAILPACK_INFO_MARKER.length;
  const newline = logs.indexOf('\n', start);
  const line = (newline === -1 ? logs.slice(start) : logs.slice(start, newline)).trim();
  if (!line) return null;

  let info: any;
  try {
    info = JSON.parse(line);
  } catch {
    // A truncated log can cut the line in half; a missing detection is fine.
    return null;
  }

  const metadata = info?.metadata ?? {};
  const providers: string[] = Array.isArray(info?.detectedProviders)
    ? info.detectedProviders.map(String)
    : [];

  // Metadata booleans are serialized as strings by railpack's Metadata.SetBool.
  const isStatic = metadata.nodeIsSPA === 'true' || metadata.nodeIsSPA === true
    || providers.includes('staticfile');

  return {
    framework: metadata.nodeRuntime ?? providers[0] ?? null,
    providers,
    isStatic,
    packageManager: metadata.nodePackageManager ?? null,
    railpackVersion: info?.railpackVersion ?? null,
  };
}

export interface DeploymentBuildConfig {
  rootDirectory?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
}

const MAX_ROOT_DIRECTORY_LENGTH = 1024;

/**
 * A repo-relative directory that is safe to interpolate into a shell command
 * and to join onto /workspace. Rejects absolute paths, traversal, and anything
 * outside a conservative path charset. Returns null when there is nothing to
 * use, so callers can treat "unset" and "unusable" identically.
 */
export function normalizeRootDirectory(raw?: string | null): string | null {
  if (!raw) return null;
  if (typeof raw !== 'string' || raw.length > MAX_ROOT_DIRECTORY_LENGTH) return null;
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return null;
  if (trimmed.startsWith('/')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return trimmed;
}

/** Filename we hand to `railpack prepare --config-file`, inside the build dir. */
export const ORCHARD_RAILPACK_CONFIG = '.orchard-railpack.json';

/**
 * The same overrides as a Railpack *config* object.
 *
 * Railpack resolves Merge(cliOptions, env, railpack.json) with the last source
 * winning (core.go:160, config.go:62), so a railpack.json committed to the repo
 * silently beats anything set in the UI. Emitting the overrides as the config
 * file instead — merged over the repo's own, ours last — puts them in the slot
 * that wins.
 *
 * Reads the RAILPACK_* variables rather than the columns so the file and the
 * env can never disagree, and shapes them exactly as
 * GenerateConfigFromEnvironment does (core.go:201-227). RAILPACK_SPA_OUTPUT_DIR
 * is absent on purpose: the node provider reads it straight from the
 * environment (spa.go:16), so no config file can outrank it.
 *
 * Returns null when there is nothing to override, so the caller can leave the
 * repo's config untouched.
 */
export function railpackConfigOverride(env: Record<string, string>): Record<string, any> | null {
  const out: Record<string, any> = {};

  // NewCopyCommand('.') then NewExecShellCommand(cmd), whose object form is
  // what UnmarshalJsonCommand dispatches on (command.go:101-140). The exec
  // command must stay an object: a bare string is split on ':' as a type
  // prefix, which would mangle `npm run build:prod`.
  const step = (cmd: string) => ({
    commands: [
      { src: '.', dest: '.' },
      { cmd: `sh -c '${cmd}'`, customName: cmd },
    ],
  });

  const install = env.RAILPACK_INSTALL_CMD?.trim();
  const build = env.RAILPACK_BUILD_CMD?.trim();
  const start = env.RAILPACK_START_CMD?.trim();

  if (install || build) {
    out.steps = {
      ...(install ? { install: step(install) } : {}),
      ...(build ? { build: step(build) } : {}),
    };
  }
  if (start) out.deploy = { startCommand: start };

  return Object.keys(out).length ? out : null;
}

/**
 * Map stored build settings onto RAILPACK_* overrides.
 *
 * Only non-empty values are emitted — a null column means "whatever Railpack
 * detected", which is the whole point of the zero-config flow. Setting an
 * output directory forces SPA mode even when Railpack's own framework
 * detection would not have triggered it (spa.go:28), which is how a static
 * site gets built and served by Caddy without any extra infrastructure.
 */
export function railpackOverrideEnv(config: DeploymentBuildConfig): Record<string, string> {
  const env: Record<string, string> = {};

  const install = config.installCommand?.trim();
  if (install) env.RAILPACK_INSTALL_CMD = install;

  const build = config.buildCommand?.trim();
  if (build) env.RAILPACK_BUILD_CMD = build;

  const start = config.startCommand?.trim();
  if (start) env.RAILPACK_START_CMD = start;

  const output = config.outputDirectory?.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (output) env.RAILPACK_SPA_OUTPUT_DIR = output;

  return env;
}
