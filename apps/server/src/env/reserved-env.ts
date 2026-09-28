/**
 * Some environment variable names belong to the container, not to the user.
 *
 * A Dockerfile's `ENV PATH=/usr/local/bun/bin:$PATH` is a build-time shell
 * expansion and reads correctly inside the image. Lifted out of the Dockerfile
 * and stored as a deployment env var it becomes a literal: Kubernetes only
 * expands `$(VAR)`, never `$VAR`, so the container comes up with a PATH of two
 * directories that do not exist. Orchard then copies every deployment env var
 * into the build job's containers, where it replaces the builder image's own
 * PATH — and BuildKit dies with `buildkitd: not found` before it can print a
 * single line of the user's build. Under Kata the sibling pusher container's
 * containerd task lands mid-sandbox-teardown and reports a 429, which is what
 * surfaces to the user: an infrastructure error for a variable we generated.
 *
 * Two boundaries, deliberately different:
 *
 *   - The build job never has a legitimate reason to take these from the user.
 *     Nobody is configuring our builder container; build args carry the values
 *     into the build by value already.
 *   - The runtime pod does. `PATH=/app/bin:/usr/bin:/bin` with no `$` is a
 *     valid override of the image default, so runtime injection is left alone.
 *
 * The fix for the generated case is not to generate it: see parseEnvVars.
 */

import { PULL_AUTH_ENV_KEYS } from '../docker/registry-pull-auth';

export { isPullAuthEnvKey } from '../docker/registry-pull-auth';

export const RUNTIME_OWNED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'PWD',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH'
]);

/**
 * Names that steer the build job rather than the build. Deliberately short:
 * withholding a variable breaks any build that legitimately wanted it, so a key
 * only earns a place here if it reconfigures our container and has no sensible
 * meaning as a build arg. AWS_ACCESS_KEY_ID is the obvious near-miss — the
 * builder reads it for the S3 cache backend, but pulling assets from S3 during
 * a build is ordinary, so it is ordered around rather than taken away.
 */
export const BUILDER_RESERVED_ENV_KEYS = new Set([
  ...RUNTIME_OWNED_ENV_KEYS,
  ...PULL_AUTH_ENV_KEYS,
  'BUILDKITD_FLAGS',
  'DOCKER_CONFIG'
]);

export interface SecretEnvRef {
  name: string;
  valueFrom: { secretKeyRef: { name: string; key: string } };
}

export function builderContainerEnv(
  envVars: Record<string, string>,
  secretName: string
): SecretEnvRef[] {
  return Object.keys(envVars)
    .filter((key) => !BUILDER_RESERVED_ENV_KEYS.has(key))
    .map((name) => ({ name, valueFrom: { secretKeyRef: { name: secretName, key: name } } }));
}

/**
 * The subset of a deployment's env vars that may enter a build at all.
 *
 * Applied once at the top of the build job so every consumer agrees on the
 * set — the container environment, the `ARG` declarations, the build args, and
 * the Railpack `--secret id=K,env=K` flags, which read the container's own
 * environment and would dangle if the two lists disagreed.
 *
 * A build arg named PATH is not merely useless: the build job declares an `ARG`
 * for every variable right below the first `FROM`, and `ARG X` exposes X to
 * every `RUN` in that stage. `ARG PATH` therefore replaces the base image's
 * PATH for the whole build, so a Dockerfile that runs `apt-get` before it sets
 * its own `ENV PATH` fails on a variable the user only ever meant for runtime.
 */
export function buildSafeEnv(envVars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envVars).filter(([key]) => !BUILDER_RESERVED_ENV_KEYS.has(key))
  );
}
