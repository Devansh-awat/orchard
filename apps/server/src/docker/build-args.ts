export function buildArgDeclarations(keys: string[]): string {
  return keys.map((key) => `ARG ${key}`).join('\n');
}

export function injectBuildArgsScript(opts: { dockerfilePath: string; keys: string[] }): string {
  return `set -ex
echo "=== Injecting ARG declarations into Dockerfile ==="

WORKSPACE="\${WORKSPACE:-/workspace}"
DOCKERFILE_PATH="${opts.dockerfilePath}"
DOCKERFILE="\${WORKSPACE}/\${DOCKERFILE_PATH}"

if [ ! -f "\${DOCKERFILE}" ]; then
  echo "Error: Dockerfile not found at \${DOCKERFILE}"
  ls -la "\${WORKSPACE}"
  exit 1
fi

ARGS_FILE="$(mktemp)"
cat > "\${ARGS_FILE}" << 'EOF'
# Auto-injected build arguments
${buildArgDeclarations(opts.keys)}

EOF

# Declare inside the stage rather than above it: an ARG before the first FROM
# is global scope and only usable by FROM lines themselves.
awk -v argsfile="\${ARGS_FILE}" '
  { print }
  /^FROM / && !done {
    while ((getline line < argsfile) > 0) print line
    close(argsfile)
    done = 1
  }
' "\${DOCKERFILE}" > "\${ARGS_FILE}.out" && mv "\${ARGS_FILE}.out" "\${DOCKERFILE}"
rm -f "\${ARGS_FILE}"

echo "=== Dockerfile updated with build args ==="
head -n 20 "\${DOCKERFILE}"
`;
}

export function injectableBuildArgKeys(
  keys: readonly string[],
  secretKeys: Iterable<string> | undefined
): string[] {
  const secret = new Set(secretKeys ?? []);
  return keys.filter((key) => !secret.has(key));
}

export function secretBuildArgNotice(
  keys: readonly string[],
  secretKeys: Iterable<string> | undefined
): string | null {
  const secret = new Set(secretKeys ?? []);
  const sealed = keys.filter((key) => secret.has(key));
  if (sealed.length === 0) return null;
  const example = sealed[0];
  return (
    `Secret variables aren't declared as ARG automatically: ${sealed.join(', ')}. ` +
    `If a build step needs one, add \`ARG ${example}\` to your Dockerfile, ` +
    `or read it without baking it into the image with \`RUN --mount=type=secret,id=${example},env=${example} ...\`.`
  );
}

export function buildSecretFlags(
  keys: readonly string[],
  secretKeys: Iterable<string> | undefined,
  envNameFor: (key: string, index: number) => string = (key) => key
): string[] {
  const secret = new Set(secretKeys ?? []);
  const flags: string[] = [];
  keys.forEach((key, index) => {
    if (secret.has(key)) flags.push(`id=${key},env=${envNameFor(key, index)}`);
  });
  return flags;
}

export interface LocalBuildArgs {
  args: string[];
  env: Record<string, string>;
}

const BUILDER_ENV_NAME =
  /^(DOCKER_|BUILDX_|BUILDKIT_|DEPOT_|COMPOSE_|ORCHARD_BUILD_SECRET_)|^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY|FTP_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|PATH|HOME|TMPDIR|XDG_[A-Z_]+)$/i;

export function isBuilderEnvName(key: string): boolean {
  return BUILDER_ENV_NAME.test(key);
}

export function localBuildArgs(
  envVars: Record<string, string>,
  secretKeys: Iterable<string> | undefined,
  skip: (key: string) => boolean = () => false
): LocalBuildArgs {
  const secret = new Set(secretKeys ?? []);
  const args: string[] = [];
  const env: Record<string, string> = {};
  let index = 0;
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || value === null || skip(key)) continue;
    if (!secret.has(key)) {
      args.push('--build-arg', `${key}=${value}`);
      continue;
    }
    const carrier = `ORCHARD_BUILD_SECRET_${index++}`;
    env[carrier] = String(value);
    args.push('--secret', `id=${key},env=${carrier}`);
    if (!isBuilderEnvName(key)) {
      env[key] = String(value);
      args.push('--build-arg', key);
    }
  }
  return { args, env };
}

export function redactBuildArgv(args: readonly string[]): string[] {
  return args.map((arg, i) => {
    if (args[i - 1] !== '--build-arg') return arg;
    const eq = arg.indexOf('=');
    return eq === -1 ? arg : `${arg.slice(0, eq)}=***`;
  });
}
