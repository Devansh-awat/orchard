import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveScratchMode,
  railpackOverrideEnv,
  railpackConfigOverride,
  normalizeRootDirectory,
  parseRailpackInfo,
  RAILPACK_INFO_MARKER,
} from '../src/docker/build-config';

test('unset build settings emit no overrides so Railpack detection wins', () => {
  assert.deepEqual(railpackOverrideEnv({}), {});
  assert.deepEqual(
    railpackOverrideEnv({
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
    }),
    {},
  );
});

test('blank strings are treated as unset, not as an empty command', () => {
  // A user clearing an input posts '' — that must mean "go back to detection",
  // not "run the empty string as the build command".
  assert.deepEqual(
    railpackOverrideEnv({ buildCommand: '   ', installCommand: '', outputDirectory: '  ' }),
    {},
  );
});

test('each setting maps to the RAILPACK_* variable railpack actually reads', () => {
  assert.deepEqual(
    railpackOverrideEnv({
      installCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm build',
      startCommand: 'node server.js',
      outputDirectory: 'dist',
    }),
    {
      RAILPACK_INSTALL_CMD: 'pnpm install --frozen-lockfile',
      RAILPACK_BUILD_CMD: 'pnpm build',
      RAILPACK_START_CMD: 'node server.js',
      RAILPACK_SPA_OUTPUT_DIR: 'dist',
    },
  );
});

test('output directory is normalized so ./dist/ and dist agree', () => {
  assert.equal(railpackOverrideEnv({ outputDirectory: './dist/' }).RAILPACK_SPA_OUTPUT_DIR, 'dist');
  assert.equal(railpackOverrideEnv({ outputDirectory: 'build' }).RAILPACK_SPA_OUTPUT_DIR, 'build');
});

test('commands are passed through verbatim apart from trimming', () => {
  // Quotes and && are legitimate in a build command; the value reaches railpack
  // as a single --env argument, so it must not be mangled here.
  const cmd = 'npm run build && echo "done"';
  assert.equal(railpackOverrideEnv({ buildCommand: `  ${cmd}  ` }).RAILPACK_BUILD_CMD, cmd);
});

test('normalizeRootDirectory accepts ordinary repo-relative paths', () => {
  assert.equal(normalizeRootDirectory('apps/web'), 'apps/web');
  assert.equal(normalizeRootDirectory('./apps/web/'), 'apps/web');
  assert.equal(normalizeRootDirectory('packages/my-app'), 'packages/my-app');
});

test('normalizeRootDirectory treats repo root as unset', () => {
  assert.equal(normalizeRootDirectory(undefined), null);
  assert.equal(normalizeRootDirectory(''), null);
  assert.equal(normalizeRootDirectory('.'), null);
  assert.equal(normalizeRootDirectory('./'), null);
});

test('normalizeRootDirectory rejects traversal, absolute paths and injection', () => {
  // This value is joined onto /workspace and interpolated into the prepare
  // container's shell script, so it is a real escape surface.
  for (const bad of [
    '../etc',
    'apps/../../etc',
    '/etc/passwd',
    'apps/web; rm -rf /',
    'apps/$(whoami)',
    'apps//web',
    'apps/web`id`',
    "apps/web'",
  ]) {
    assert.equal(normalizeRootDirectory(bad), null, `expected ${bad} to be rejected`);
  }
});

// `railpack prepare --info-out` writes core.BuildResult with the plan stripped
// (railpack cli/prepare.go:80). Metadata booleans are strings (Metadata.SetBool).
function infoLine(info: unknown, surroundingLog = true): string {
  const line = `${RAILPACK_INFO_MARKER}${JSON.stringify(info)}`;
  return surroundingLog
    ? `=== Running Railpack prepare ===\nsome noise\n${line}\ntrailing line\n`
    : line;
}

test('railpack info reveals a detected SPA', () => {
  const detection = parseRailpackInfo(
    infoLine({
      railpackVersion: 'v0.33.0',
      detectedProviders: ['node'],
      metadata: { nodeRuntime: 'vite', nodePackageManager: 'pnpm', nodeIsSPA: 'true' },
      success: true,
    }),
  )!;
  assert.equal(detection.framework, 'vite');
  assert.equal(detection.isStatic, true);
  assert.equal(detection.packageManager, 'pnpm');
  assert.equal(detection.railpackVersion, 'v0.33.0');
  assert.deepEqual(detection.providers, ['node']);
});

test('a server-rendered node app is not reported as static', () => {
  const detection = parseRailpackInfo(
    infoLine({
      detectedProviders: ['node'],
      metadata: { nodeRuntime: 'next', nodeIsSPA: 'false' },
    }),
  )!;
  assert.equal(detection.framework, 'next');
  assert.equal(detection.isStatic, false);
});

test('the staticfile provider counts as static even without node metadata', () => {
  const detection = parseRailpackInfo(infoLine({ detectedProviders: ['staticfile'], metadata: {} }))!;
  assert.equal(detection.isStatic, true);
  assert.equal(detection.framework, 'staticfile');
});

test('a non-node provider falls back to the provider name', () => {
  const detection = parseRailpackInfo(infoLine({ detectedProviders: ['go'], metadata: {} }))!;
  assert.equal(detection.framework, 'go');
  assert.equal(detection.isStatic, false);
});

test('logs without a marker, or with a truncated one, yield no detection', () => {
  assert.equal(parseRailpackInfo(''), null);
  assert.equal(parseRailpackInfo(null), null);
  assert.equal(parseRailpackInfo('build finished, nothing to see'), null);
  // A tail-truncated log can cut the JSON in half.
  assert.equal(parseRailpackInfo(`${RAILPACK_INFO_MARKER}{"detectedProv`), null);
  assert.equal(parseRailpackInfo(RAILPACK_INFO_MARKER), null);
});

test('the last marker wins when a log contains several', () => {
  // Retried builds can append a second prepare run to the same log.
  const logs = infoLine({ detectedProviders: ['node'], metadata: { nodeRuntime: 'vite' } })
    + infoLine({ detectedProviders: ['node'], metadata: { nodeRuntime: 'next' } });
  assert.equal(parseRailpackInfo(logs)!.framework, 'next');
});

test('no build settings means no config file, leaving the repo railpack.json alone', () => {
  assert.equal(railpackConfigOverride({}), null);
  assert.equal(railpackConfigOverride({ RAILPACK_SPA_OUTPUT_DIR: 'dist' }), null);
});

test('commands become a config file so the UI outranks a repo railpack.json', () => {
  // Railpack merges Merge(cliOptions, env, railpack.json) with the last source
  // winning, so overrides only stick if they arrive as the config file.
  assert.deepEqual(
    railpackConfigOverride({
      RAILPACK_INSTALL_CMD: 'pnpm install',
      RAILPACK_BUILD_CMD: 'pnpm build',
      RAILPACK_START_CMD: 'node build',
    }),
    {
      steps: {
        install: {
          commands: [
            { src: '.', dest: '.' },
            { cmd: "sh -c 'pnpm install'", customName: 'pnpm install' },
          ],
        },
        build: {
          commands: [
            { src: '.', dest: '.' },
            { cmd: "sh -c 'pnpm build'", customName: 'pnpm build' },
          ],
        },
      },
      deploy: { startCommand: 'node build' },
    },
  );
});

test('a command containing a colon stays an object, not a prefixed string', () => {
  // UnmarshalStringCommand splits a bare string on ':' as a type prefix, so
  // `npm run build:prod` would be parsed as command type "npm run build".
  const cfg = railpackConfigOverride({ RAILPACK_BUILD_CMD: 'npm run build:prod' })!;
  const cmd = cfg.steps.build.commands[1];
  assert.equal(typeof cmd, 'object');
  assert.equal(cmd.cmd, "sh -c 'npm run build:prod'");
});

test('a start command alone does not invent empty build steps', () => {
  assert.deepEqual(
    railpackConfigOverride({ RAILPACK_START_CMD: 'node build' }),
    { deploy: { startCommand: 'node build' } },
  );
});

test('without an isolation runtime, scratch is disk-backed so builds are not capped by node RAM', () => {
  assert.equal(resolveScratchMode(undefined, undefined), 'disk');
  assert.equal(resolveScratchMode('', undefined), 'disk');
});

test('under a VM runtime, scratch stays on tmpfs to keep off virtio-fs', () => {
  assert.equal(resolveScratchMode(undefined, 'kata'), 'tmpfs');
});

test('an explicit mode always wins over the isolation default', () => {
  assert.equal(resolveScratchMode('tmpfs', undefined), 'tmpfs');
  assert.equal(resolveScratchMode('disk', 'kata'), 'disk');
  assert.equal(resolveScratchMode('block', 'kata'), 'block');
  assert.equal(resolveScratchMode(' block ', undefined), 'block');
});

test('an unrecognised mode falls back to the isolation default rather than breaking the build', () => {
  assert.equal(resolveScratchMode('nonsense', 'kata'), 'tmpfs');
  assert.equal(resolveScratchMode('nonsense', undefined), 'disk');
});
